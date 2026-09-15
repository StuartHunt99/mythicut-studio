const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('imageTagging', Object.freeze({
  command: (command, payload) => ipcRenderer.invoke('image-tagging-command', command, payload),
  onEvent: callback => {
    if (typeof callback !== 'function') throw new Error('Event callback is required');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('image-tagging-event', listener);
    return () => ipcRenderer.removeListener('image-tagging-event', listener);
  }
}));
