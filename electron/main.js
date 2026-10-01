const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { startServer } = require('../server/server');

let mainWindow = null;
let server = null;

function resolveDistDir() {
  const root = path.join(__dirname, '..');
  const candidates = [
    path.join(root, 'dist', 'randomizer-app', 'browser'), // Angular 17 output
    path.join(root, 'dist', 'randomizer-app')
  ];
  return candidates.find(dir => fs.existsSync(path.join(dir, 'index.html'))) || candidates[0];
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    autoHideMenuBar: true,
    title: 'Game Randomizer',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  mainWindow.loadURL(url);
}

app.whenReady().then(() => {
  // writable data folder: repo /data in dev, %APPDATA%\Randomizer\data when packaged
  const dataDir = app.isPackaged
    ? path.join(app.getPath('userData'), 'data')
    : path.join(__dirname, '..', 'data');

  server = startServer({ port: 0, staticDir: resolveDistDir(), dataDir });
  const port = server.address().port;

  createWindow(`http://127.0.0.1:${port}/`);
});

app.on('window-all-closed', () => {
  if (server) server.close();
  app.quit();
});