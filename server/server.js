const express = require('express');
const fs = require('fs');
const path = require('path');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');

const PLATFORMS = [
  { id: 'nes',           name: 'NES' },
  { id: 'sega-genesis',  name: 'SEGA GENESIS' },
  { id: 'ps1',           name: 'PS1' },
  { id: 'super-famicom', name: 'SUPER FAMICOM' }
];

const DEFAULT_SEED = {
  'nes':           ['Super Mario Bros.', 'Contra', 'Mega Man 2', 'Castlevania', 'DuckTales'],
  'sega-genesis':  ['Sonic the Hedgehog', 'Streets of Rage 2', 'Gunstar Heroes', 'Comix Zone'],
  'ps1':           ['Final Fantasy VII', 'Metal Gear Solid', 'Crash Bandicoot', 'Spyro the Dragon'],
  'super-famicom': ['Super Mario World', 'Chrono Trigger', 'Donkey Kong Country', 'Star Fox']
};

const XML_OPTS = { ignoreAttributes: false, attributeNamePrefix: '@_' };

// ---------------- storage helpers ----------------

const jsonFile = (dir, id) => path.join(dir, `${id}.json`);
const xmlFile  = (dir, id) => path.join(dir, `${id}.xml`);

const cleanItems = items => (items ?? []).map(i => String(i).trim()).filter(Boolean);

function writeList(dir, id, items, format) {
  const clean = cleanItems(items);
  const updatedAt = new Date().toISOString();

  if (format === 'xml') {
    const builder = new XMLBuilder({ ...XML_OPTS, format: true, indentBy: '  ', suppressEmptyNode: true });
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      builder.build({
        list: { '@_platform': id, '@_updatedAt': updatedAt, items: { item: clean } }
      });
    fs.writeFileSync(xmlFile(dir, id), xml, 'utf8');
    try { fs.unlinkSync(jsonFile(dir, id)); } catch { /* not there */ }
  } else {
    fs.writeFileSync(
      jsonFile(dir, id),
      JSON.stringify({ platform: id, items: clean, updatedAt }, null, 2),
      'utf8'
    );
    try { fs.unlinkSync(xmlFile(dir, id)); } catch { /* not there */ }
  }

  return { platform: id, format, items: clean, updatedAt };
}

function readList(dir, id, preferredFormat) {
  const order = preferredFormat === 'xml' ? ['xml', 'json'] : ['json', 'xml'];

  for (const format of order) {
    try {
      if (format === 'json') {
        const parsed = JSON.parse(fs.readFileSync(jsonFile(dir, id), 'utf8'));
        return { platform: id, format, items: cleanItems(parsed.items), updatedAt: parsed.updatedAt ?? null };
      } else {
        const raw = fs.readFileSync(xmlFile(dir, id), 'utf8');
        const parsed = new XMLParser(XML_OPTS).parse(raw);
        let items = parsed?.list?.items?.item ?? [];
        if (!Array.isArray(items)) items = [items];
        return { platform: id, format, items: cleanItems(items), updatedAt: parsed?.list?.['@_updatedAt'] ?? null };
      }
    } catch { /* file missing/broken — try the other format */ }
  }
  return { platform: id, format: preferredFormat, items: [], updatedAt: null };
}

function ensureDataDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  for (const p of PLATFORMS) {
    if (!fs.existsSync(jsonFile(dir, p.id)) && !fs.existsSync(xmlFile(dir, p.id))) {
      writeList(dir, p.id, DEFAULT_SEED[p.id] ?? [], 'json');
    }
  }
}

// ---------------- server ----------------

function startServer({ port = 3000, staticDir = null, dataDir } = {}) {
  dataDir = dataDir || path.join(__dirname, '..', 'data');
  ensureDataDir(dataDir);

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/platforms', (_req, res) => res.json(PLATFORMS));

  app.get('/api/lists/:id', (req, res) => {
    const platform = PLATFORMS.find(p => p.id === req.params.id);
    if (!platform) return res.status(404).json({ error: 'Unknown platform' });
    const format = req.query.format === 'xml' ? 'xml' : 'json';
    res.json(readList(dataDir, platform.id, format));
  });

  app.put('/api/lists/:id', (req, res) => {
    const platform = PLATFORMS.find(p => p.id === req.params.id);
    if (!platform) return res.status(404).json({ error: 'Unknown platform' });
    if (!Array.isArray(req.body?.items)) {
      return res.status(400).json({ error: 'Body must be { "items": [...], "format": "json"|"xml" }' });
    }
    const format = req.body.format === 'xml' ? 'xml' : 'json';
    res.json(writeList(dataDir, platform.id, req.body.items, format));
  });

  app.delete('/api/lists/:id', (req, res) => {
    const platform = PLATFORMS.find(p => p.id === req.params.id);
    if (!platform) return res.status(404).json({ error: 'Unknown platform' });
    res.json(writeList(dataDir, platform.id, [], 'json'));
  });

  // serve the built Angular app (used by Electron)
  if (staticDir && fs.existsSync(path.join(staticDir, 'index.html'))) {
    app.use(express.static(staticDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  return app.listen(port);
}

module.exports = { startServer, PLATFORMS };

// standalone mode: node server/server.js
if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  startServer({ port, dataDir });
  console.log(`Randomizer API  → http://localhost:${port}/api/platforms`);
  console.log(`Data folder     → ${dataDir}`);
}