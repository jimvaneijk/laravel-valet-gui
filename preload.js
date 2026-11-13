const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  data: () => ipcRenderer.invoke('data'),
  valet: (args, opts) => ipcRenderer.invoke('valet', args, opts),
  pickFolder: () => ipcRenderer.invoke('pickFolder'),
  openUrl: url => ipcRenderer.invoke('openUrl', url),
  reveal: p => ipcRenderer.invoke('reveal', p),
  onUpdate: cb => ipcRenderer.on('update', (_e, version) => cb(version)),
});
