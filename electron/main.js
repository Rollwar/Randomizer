const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { startServer } = require('../server/server');

let mainWindow = null;
let server = null;
let rouletteDir = null;

function resolveDistDir() {
  const root = path.join(__dirname, '..');
  const candidates = [
    path.join(root, 'dist', 'randomizer-app', 'browser'),
    path.join(root, 'dist', 'randomizer-app')
  ];
  return candidates.find(dir => fs.existsSync(path.join(dir, 'index.html'))) || candidates[0];
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    frame: false,                 // ← frameless: custom title bar in the UI
    backgroundColor: '#0f172a',
    title: 'Game Randomizer',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0f172a',
      symbolColor: '#e2e8f0',
      height: 40
    },
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
  const rootDir = path.join(__dirname, '..');
  const writableRoot = app.isPackaged ? app.getPath('userData') : rootDir;
  const dataDir = app.isPackaged ? path.join(writableRoot, 'data') : path.join(rootDir, 'data');
  rouletteDir = app.isPackaged ? path.join(writableRoot, 'roulette') : path.join(rootDir, 'roulette');

  server = startServer({ port: 0, staticDir: resolveDistDir(), dataDir, rouletteDir });
  const port = server.address().port;

  // ---- IPC: folder + custom window controls ----
  ipcMain.handle('roulette:open-folder', async () => shell.openPath(rouletteDir));
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:toggle-maximize', () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  });
  ipcMain.on('window:close', () => mainWindow?.close());

  createWindow(`http://127.0.0.1:${port}/`);
});

app.on('window-all-closed', () => {
  if (server) server.close();
  app.quit();
});