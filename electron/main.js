const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { startServer } = require('../server/server');

let mainWindow = null;
let server = null;
let rouletteDir = null;
let platformsDir = null;

function resolveDistDir() {
  const root = path.join(__dirname, '..');
  const candidates = [
    path.join(root, 'dist', 'randomizer-app', 'browser'),
    path.join(root, 'dist', 'randomizer-app')
  ];
  return candidates.find(dir => fs.existsSync(path.join(dir, 'index.html'))) || candidates[0];
}

function resolveWindowIcon() {
  const p = path.join(__dirname, '..', 'build', 'pixel_green_elephant.ico');
  return fs.existsSync(p) ? p : undefined;
}

/** Where the app "lives": portable dir → install dir → repo root (dev). */
function resolveAppRoot() {
  // electron-builder "portable" target: the exe unpacks to %TEMP% at runtime,
  // this env var points at the folder the portable exe was launched from
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  if (app.isPackaged) return path.dirname(app.getPath('exe')); // install dir, next to the exe
  return path.join(__dirname, '..');                           // dev: repo root
}

function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch { return false; }
}

/** Prefers the exe folder; falls back to %APPDATA% only if it's read-only. */
function resolveWritableRoot() {
  const exeRoot = resolveAppRoot();
  if (isWritable(exeRoot)) return exeRoot;

  const fallback = app.getPath('userData');
  console.warn(`[Randomizer] "${exeRoot}" is not writable — falling back to "${fallback}"`);
  return fallback;
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    frame: false,
    backgroundColor: '#0b1a12',
    title: 'Mad Randomizer',
    icon: resolveWindowIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWindow.loadURL(url);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.example.randomizer');

  const writableRoot = resolveWritableRoot();
  const dataDir      = path.join(writableRoot, 'data');
  rouletteDir        = path.join(writableRoot, 'roulette');
  platformsDir       = path.join(writableRoot, 'platforms');

  server = startServer({ port: 0, staticDir: resolveDistDir(), dataDir, rouletteDir, platformsDir });
  const port = server.address().port;

  // ---- IPC: folders + custom window controls ----
  ipcMain.handle('roulette:open-folder',  async () => shell.openPath(rouletteDir));
  ipcMain.handle('platforms:open-folder', async () => shell.openPath(platformsDir));
  ipcMain.on('window:minimize',        () => mainWindow?.minimize());
  ipcMain.on('window:toggle-maximize', () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  });
  ipcMain.on('window:close',           () => mainWindow?.close());

  createWindow(`http://127.0.0.1:${port}/`);
});

app.on('window-all-closed', () => {
  if (server) server.close();
  app.quit();
});