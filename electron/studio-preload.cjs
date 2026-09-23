const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studio', Object.freeze({
  selectTab: tab => ipcRenderer.invoke('studio-select-tab', tab)
}));

contextBridge.exposeInMainWorld('projects', Object.freeze({
  command: (action, payload) => ipcRenderer.invoke('project-command', action, payload),
  onProgress: callback => ipcRenderer.on('project-progress', (_event, progress) => callback(progress))
}));

contextBridge.exposeInMainWorld('imageTagging', Object.freeze({
  command: (command, payload) => ipcRenderer.invoke('image-tagging-command', command, payload),
  onEvent: callback => {
    if (typeof callback !== 'function') throw new Error('Event callback is required');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('image-tagging-event', listener);
    return () => ipcRenderer.removeListener('image-tagging-event', listener);
  }
}));
