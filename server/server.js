const express = require('express');
const fs = require('fs');
const path = require('path');
const { PlatformRegistry } = require('./platforms');
const { ensureDir, writeList, readList } = require('./storage');
const { scanRoulette } = require('./roulette-scan');

function startServer({ port = 3000, staticDir = null, dataDir, platformsDir, rouletteDir } = {}) {
  const root = path.join(__dirname, '..');
  dataDir = dataDir || path.join(root, 'data');
  platformsDir = platformsDir || path.join(root, 'platforms');
  rouletteDir = rouletteDir || path.join(root, 'roulette');

  ensureDir(dataDir);
  ensureDir(platformsDir);
  ensureDir(rouletteDir);

  const registry = new PlatformRegistry({ platformsDir, dataDir });
  registry.init();      // scan platforms.txt + import games on startup
  registry.watch();     // keep watching the platforms folder for txt changes

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // ---------- roulette media (music, stop sound, icons, backgrounds) ----------
  app.use('/roulette', express.static(rouletteDir));

  app.get('/api/assets', (_req, res) =>
    res.json({
      ...scanRoulette(rouletteDir),
      platformsDir,
      platformCount: registry.list().length
    })
  );

  // ---------- platforms (dynamic, driven by platforms.txt) ----------
  app.get('/api/platforms', (_req, res) => res.json(registry.list()));

  // force re-import of {platform}.games.txt (overwrites the stored list)
  app.post('/api/platforms/:id/import', (req, res) => {
    if (!registry.has(req.params.id)) return res.status(404).json({ error: 'Unknown platform' });
    const result = registry.importGames(req.params.id, { force: true });
    if (result.imported) registry.emit('list', req.params.id);
    res.json(result);
  });

  // ---------- game lists (json/xml storage) ----------
  app.get('/api/lists/:id', (req, res) => {
    if (!registry.has(req.params.id)) return res.status(404).json({ error: 'Unknown platform' });
    const format = req.query.format === 'xml' ? 'xml' : 'json';
    res.json(readList(dataDir, req.params.id, format));
  });

  app.put('/api/lists/:id', (req, res) => {
    if (!registry.has(req.params.id)) return res.status(404).json({ error: 'Unknown platform' });
    if (!Array.isArray(req.body?.items)) {
      return res.status(400).json({ error: 'Body must be { "items": [...], "format": "json"|"xml" }' });
    }
    const format = req.body.format === 'xml' ? 'xml' : 'json';
    res.json(writeList(dataDir, req.params.id, req.body.items, format));
  });

  app.delete('/api/lists/:id', (req, res) => {
    if (!registry.has(req.params.id)) return res.status(404).json({ error: 'Unknown platform' });
    res.json(writeList(dataDir, req.params.id, [], 'json'));
  });

  // ---------- app settings (theme, volume) ----------
  const settingsFile = path.join(dataDir, 'settings.json');

  const readSettings = () => {
    try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; }
  };

  app.get('/api/settings', (_req, res) => res.json(readSettings()));

  app.put('/api/settings', (req, res) => {
    if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Body must be a JSON object' });
    }
    const patch = {};
    if (['default', 'green', 'purple'].includes(req.body.theme)) patch.theme = req.body.theme;
    if (typeof req.body.volume === 'number' && req.body.volume >= 0 && req.body.volume <= 100) {
      patch.volume = Math.round(req.body.volume);
    }
    const merged = { ...readSettings(), ...patch, updatedAt: new Date().toISOString() };
    fs.writeFileSync(settingsFile, JSON.stringify(merged, null, 2), 'utf8');
    res.json(merged);
  });

  // ---------- per-platform roll state (last result, tape, history, queue) ----------
  const rollsDir = path.join(dataDir, 'rolls');
  ensureDir(rollsDir);
  const rollsFile = id => path.join(rollsDir, `${id}.json`);

  app.get('/api/rolls/:id', (req, res) => {
    if (!registry.has(req.params.id)) return res.status(404).json({ error: 'Unknown platform' });
    let snap = null;
    try { snap = JSON.parse(fs.readFileSync(rollsFile(req.params.id), 'utf8')); } catch { /* none yet */ }
    res.json(snap ?? null);
  });

  app.put('/api/rolls/:id', (req, res) => {
    if (!registry.has(req.params.id)) return res.status(404).json({ error: 'Unknown platform' });
    const snap = req.body;
    if (typeof snap !== 'object' || snap === null || Array.isArray(snap)) {
      return res.status(400).json({ error: 'Body must be a snapshot object' });
    }
    fs.writeFileSync(
      rollsFile(req.params.id),
      JSON.stringify({ ...snap, updatedAt: new Date().toISOString() }, null, 2),
      'utf8'
    );
    res.json({ saved: true });
  });

  // ---------- SSE: live updates for connected clients ----------
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();

    const send = payload => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const unsubscribe = registry.onChange(payload => send(payload));
    const heartbeat = setInterval(() => res.write(': hb\n\n'), 25000);

    req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  });

  // serve the built Angular app (used by Electron)
  if (staticDir && fs.existsSync(path.join(staticDir, 'index.html'))) {
    app.use(express.static(staticDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/roulette/')) return next();
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  const server = app.listen(port);
  server.on('close', () => registry.stopWatching());
  server.registry = registry; // exposed for tests/tools
  return server;
}

module.exports = { startServer };

// standalone mode: node server/server.js
if (require.main === module) {
  const root = path.join(__dirname, '..');
  const port = Number(process.env.PORT) || 3000;
  startServer({
    port,
    dataDir: process.env.DATA_DIR || path.join(root, 'data'),
    platformsDir: process.env.PLATFORMS_DIR || path.join(root, 'platforms'),
    rouletteDir: process.env.ROULETTE_DIR || path.join(root, 'roulette')
  });
  console.log(`Randomizer API   → http://localhost:${port}/api/platforms`);
  console.log(`Data folder      → ${process.env.DATA_DIR || path.join(root, 'data')}`);
  console.log(`Platforms folder → ${process.env.PLATFORMS_DIR || path.join(root, 'platforms')}`);
  console.log(`Roulette folder  → ${process.env.ROULETTE_DIR || path.join(root, 'roulette')}`);
}