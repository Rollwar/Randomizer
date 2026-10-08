const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { cleanItems, ensureDir, writeList, readList } = require('./storage');

const PLATFORMS_FILE = 'platforms.txt';
const GAMES_SUFFIX = '.games.txt';

const DEFAULT_PLATFORMS = ['NES', 'SEGA GENESIS', 'PS1', 'SUPER NINTENDO'];

const DEFAULT_GAMES = {
  'nes': ['Super Mario Bros.', 'Contra', 'Mega Man 2', 'Castlevania', 'DuckTales'],
  'sega-genesis': ['Sonic the Hedgehog', 'Streets of Rage 2', 'Gunstar Heroes', 'Comix Zone'],
  'ps1': ['Final Fantasy VII', 'Metal Gear Solid', 'Crash Bandicoot', 'Spyro the Dragon'],
  'super-nintendo': ['Super Mario World', 'Chrono Trigger', 'Donkey Kong Country', 'Star Fox']
};

const FULL_SCAN = '__full_scan__';

const slugify = name =>
  String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** One item per line; full-line comments (# or ;) and blanks are skipped; BOM tolerated. */
function parseTxt(content) {
  return String(content ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith(';'));
}

/** "id | Name" or just "Name" (id = slugified name). Duplicates ignored. */
function parsePlatformsTxt(content) {
  const result = [];
  const seen = new Set();
  for (const line of parseTxt(content)) {
    const bar = line.indexOf('|');
    const name = bar >= 0 ? line.slice(bar + 1).trim() : line;
    const id = slugify(bar >= 0 ? line.slice(0, bar) : line);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, name });
  }
  return result;
}

class PlatformRegistry {
  constructor({ platformsDir, dataDir }) {
    this.platformsDir = platformsDir;
    this.dataDir = dataDir;
    this.importsFile = path.join(dataDir, '.imports.json'); // hash of last imported games txt
    this.platforms = [];            // ordered [{ id, name }]
    this.listeners = new Set();     // change listeners (SSE)
    this.watchers = [];
    this.debounceTimers = new Map();
  }

  // ---------- change notifications ----------
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, platform = null) {
    for (const fn of this.listeners) { try { fn({ type, platform }); } catch { /* listener error */ } }
  }

  list() { return this.platforms.map(p => ({ ...p })); }
  has(id) { return this.platforms.some(p => p.id === id); }

  // ---------- import bookkeeping ----------
  readImportsMeta() {
    try { return JSON.parse(fs.readFileSync(this.importsFile, 'utf8')); } catch { return {}; }
  }

  writeImportsMeta(meta) {
    try { fs.writeFileSync(this.importsFile, JSON.stringify(meta, null, 2), 'utf8'); } catch { /* non-fatal */ }
  }

  fileHash(file) {
    try { return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex'); }
    catch { return null; }
  }

  // ---------- samples ----------
  /** Creates platforms.txt + default games files if the folder is empty (first run). */
  ensureSamples() {
    ensureDir(this.platformsDir);

    const pf = path.join(this.platformsDir, PLATFORMS_FILE);
    if (!fs.existsSync(pf)) {
      fs.writeFileSync(
        pf,
        '# One platform per line: "id | Display Name" or just "Display Name"\n' +
        DEFAULT_PLATFORMS.join('\n') + '\n',
        'utf8'
      );

      for (const [id, games] of Object.entries(DEFAULT_GAMES)) {
        const gf = path.join(this.platformsDir, `${id}${GAMES_SUFFIX}`);
        if (!fs.existsSync(gf)) {
          fs.writeFileSync(gf, '# One game per line\n' + games.join('\n') + '\n', 'utf8');
        }
      }
    }
  }

  // ---------- registry sync ----------
  /** Re-reads platforms.txt. Returns { added, removed } (id arrays). */
  syncPlatforms() {
    const pf = path.join(this.platformsDir, PLATFORMS_FILE);
    let parsed = [];
    try { parsed = parsePlatformsTxt(fs.readFileSync(pf, 'utf8')); } catch { /* keep current */ }

    const prev = new Map(this.platforms.map(p => [p.id, p]));
    // an empty/broken platforms.txt must not wipe the registry
    this.platforms = parsed.length ? parsed : [...prev.values()];

    return {
      added: this.platforms.filter(p => !prev.has(p.id)).map(p => p.id),
      removed: [...prev.keys()].filter(id => !this.platforms.some(p => p.id === id))
    };
  }

  /** Finds X.games.txt for a platform — matches id or name, case-insensitive. */
  findGamesFile(id) {
    let entries = [];
    try { entries = fs.readdirSync(this.platformsDir); } catch { return null; }

    const platform = this.platforms.find(p => p.id === id);
    const candidates = new Set([id.toLowerCase()]);
    if (platform) candidates.add(slugify(platform.name).toLowerCase());

    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith(GAMES_SUFFIX)) continue;
      const stem = entry.slice(0, -GAMES_SUFFIX.length).toLowerCase();
      if (candidates.has(stem) || candidates.has(slugify(stem))) {
        return path.join(this.platformsDir, entry);
      }
    }
    return null;
  }

  resolvePlatformIdByFileName(stem) {
    const s = stem.toLowerCase();
    const byId = this.platforms.find(p => p.id.toLowerCase() === s);
    if (byId) return byId.id;
    const byName = this.platforms.find(p => slugify(p.name).toLowerCase() === slugify(s));
    return byName ? byName.id : null;
  }

  // ---------- import ----------
  /**
   * Imports games for a platform from its .games.txt.
   * Overwrites the stored list only when the file content changed (or force = true).
   * Never overwrites pre-existing user data on the very first sight of a file.
   */
  importGames(id, { force = false } = {}) {
    if (!this.has(id)) return { imported: false, reason: 'unknown platform' };

    const file = this.findGamesFile(id);
    if (!file) return { imported: false, reason: 'no games file' };

    const hash = this.fileHash(file);
    if (!hash) return { imported: false, reason: 'unreadable file' };

    const meta = this.readImportsMeta();
    const known = meta[id];
    if (!force && known === hash) return { imported: false, reason: 'unchanged' };

    // protect lists edited by the user before the file was ever seen
    if (!force && known === undefined) {
      const stored = readList(this.dataDir, id, 'json');
      if (stored.items.length > 0) {
        meta[id] = hash;
        this.writeImportsMeta(meta);
        return { imported: false, reason: 'existing data kept (force import to overwrite)' };
      }
    }

    let items = [];
    try { items = cleanItems(parseTxt(fs.readFileSync(file, 'utf8'))); }
    catch { return { imported: false, reason: 'parse error' }; }

    writeList(this.dataDir, id, items, 'json');
    meta[id] = hash;
    this.writeImportsMeta(meta);
    return { imported: true, count: items.length };
  }

  importAll(onlyIds = null) {
    const results = {};
    for (const p of this.platforms) {
      if (onlyIds && !onlyIds.includes(p.id)) continue;
      results[p.id] = this.importGames(p.id);
    }
    return results;
  }

  // ---------- lifecycle ----------
  init() {
    this.ensureSamples();
    this.syncPlatforms();
    this.importAll();
  }

  watch() {
    try {
      const watcher = fs.watch(this.platformsDir, (_event, filename) => {
        const name = filename ? String(filename) : null;
        if (!name) { this.scheduleHandle(FULL_SCAN); return; }
        if (name !== PLATFORMS_FILE && !name.toLowerCase().endsWith(GAMES_SUFFIX)) return;
        this.scheduleHandle(name);
      });
      this.watchers.push(watcher);
    } catch { /* folder missing — samples were created in init(), restart recovers */ }
  }

  scheduleHandle(key) {
    const prev = this.debounceTimers.get(key);
    if (prev) clearTimeout(prev);
    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key);
      this.handleFileChange(key);
    }, 300));
  }

  handleFileChange(key) {
    if (key === FULL_SCAN) {
      const { added } = this.syncPlatforms();
      if (added.length) this.importAll(added);
      this.emit('platforms');
      return;
    }

    if (key === PLATFORMS_FILE) {
      const { added } = this.syncPlatforms();
      if (added.length) this.importAll(added);
      this.emit('platforms');           // UI refreshes the platform menu
      return;
    }

    // *.games.txt
    const stem = key.slice(0, -GAMES_SUFFIX.length);
    const id = this.resolvePlatformIdByFileName(stem);
    if (!id) return;                    // games file for a platform not in platforms.txt yet
    const res = this.importGames(id);
    if (res.imported) this.emit('list', id);
  }

  stopWatching() {
    for (const w of this.watchers) { try { w.close(); } catch { /* already closed */ } }
    this.watchers = [];
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
  }
}

module.exports = { PlatformRegistry, parseTxt, parsePlatformsTxt, slugify };