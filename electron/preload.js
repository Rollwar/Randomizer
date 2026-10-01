const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('randomizer', {
  isDesktop: true,
  openRouletteFolder: () => ipcRenderer.invoke('roulette:open-folder'),
  minimize:           () => ipcRenderer.send('window:minimize'),
  toggleMaximize:     () => ipcRenderer.send('window:toggle-maximize'),
  close:              () => ipcRenderer.send('window:close')
});