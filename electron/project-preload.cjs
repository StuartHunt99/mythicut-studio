const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('projects', {
  command: (action, payload) => ipcRenderer.invoke('project-command', action, payload),
  onProgress: callback => ipcRenderer.on('project-progress', (_event, progress) => callback(progress))
});
