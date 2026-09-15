const { ipcMain, dialog, safeStorage, app, utilityProcess } = require('electron');
const { mkdir, readFile, rename, writeFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

module.exports = async function registerImageTagging(window, initialPath) {
  const page = pathToFileURL(path.join(__dirname, 'tagging.html')).href;
  const catalogDirectory = path.join(app.getPath('userData'), 'image-catalogs');
  const credentialDirectory = path.join(app.getPath('userData'), 'image-tagging-credentials');
  await mkdir(catalogDirectory, { recursive: true });
  await mkdir(credentialDirectory, { recursive: true });
  let location = initialPath ? path.resolve(initialPath) : path.join(catalogDirectory, 'default.sqlite');
  let snapshot = null;
  let sequence = 0;
  const pending = new Map();
  const worker = utilityProcess.fork(path.join(__dirname, 'tagging-worker.cjs'));

  worker.on('message', message => {
    if (message.type === 'event') {
      if (!window.isDestroyed()) window.webContents.send('image-tagging-event', message.event);
      return;
    }
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    message.error ? request.reject(new Error(message.error)) : request.resolve(message.result);
  });
  worker.on('error', error => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  worker.on('exit', code => {
    if (!code) return;
    const error = new Error(`Image tagging worker stopped unexpectedly (${code})`);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });

  function send(command, payload = {}) {
    return new Promise((resolve, reject) => {
      const requestId = ++sequence;
      pending.set(requestId, { resolve, reject });
      worker.postMessage({ requestId, command, payload });
    });
  }

  function assertOrigin(event) {
    const origin = new URL(event.senderFrame?.url ?? 'about:blank');
    origin.search = ''; origin.hash = '';
    if (event.sender !== window.webContents || origin.href !== page) throw new Error('Invalid image tagging command origin');
  }

  async function saveCredential(secret, existingRef) {
    if (typeof secret !== 'string' || secret.trim().length < 8 || secret.length > 1000) throw new Error('Enter a valid API key');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this computer');
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') throw new Error('Configure a system keyring before saving API credentials');
    const ref = existingRef && /^[a-f0-9-]{36}$/.test(existingRef) ? existingRef : randomUUID();
    const encrypted = await safeStorage.encryptStringAsync(secret.trim());
    const destination = path.join(credentialDirectory, `${ref}.bin`);
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, encrypted, { mode: 0o600 });
    await rename(temporary, destination);
    return ref;
  }

  async function loadCredential(ref) {
    if (typeof ref !== 'string' || !/^[a-f0-9-]{36}$/.test(ref)) throw new Error('Provider credential is not configured');
    const encrypted = await readFile(path.join(credentialDirectory, `${ref}.bin`));
    const decrypted = await safeStorage.decryptStringAsync(encrypted);
    return decrypted.result;
  }

  async function refresh() {
    snapshot = await send('catalog.snapshot');
    return { ...snapshot, location };
  }

  snapshot = await send('catalog.open', { databasePath: location, name: 'MythiCut image catalog' });

  ipcMain.handle('image-tagging-command', async (event, command, payload = {}) => {
    assertOrigin(event);
    switch (command) {
      case 'get': return refresh();
      case 'catalog.new': {
        const selection = await dialog.showSaveDialog(window, { title: 'Create image catalog', defaultPath: 'MythiCut Images.sqlite', filters: [{ name: 'MythiCut image catalog', extensions: ['sqlite'] }] });
        if (selection.canceled) return { ...snapshot, location };
        location = path.resolve(selection.filePath);
        snapshot = await send('catalog.open', { databasePath: location, name: path.basename(location, path.extname(location)) });
        return { ...snapshot, location };
      }
      case 'catalog.open': {
        const selection = await dialog.showOpenDialog(window, { title: 'Open image catalog', properties: ['openFile'], filters: [{ name: 'MythiCut image catalog', extensions: ['sqlite', 'db'] }] });
        if (selection.canceled) return { ...snapshot, location };
        location = path.resolve(selection.filePaths[0]);
        snapshot = await send('catalog.open', { databasePath: location });
        return { ...snapshot, location };
      }
      case 'roots.choose': {
        const selection = await dialog.showOpenDialog(window, { title: 'Choose image folders', properties: ['openDirectory', 'multiSelections'] });
        if (!selection.canceled) for (const selected of selection.filePaths) await send('roots.add', { path: selected, recursive: payload.recursive !== false, includeHidden: Boolean(payload.includeHidden), excludes: payload.excludes ?? [] });
        return refresh();
      }
      case 'provider.save': {
        const profileId = payload.id ?? randomUUID();
        const existing = snapshot?.providers?.find(provider => provider.id === profileId);
        let credentialRef = existing?.hasCredential ? profileId : null;
        if (payload.apiKey) credentialRef = await saveCredential(payload.apiKey, profileId);
        const value = { ...payload, id: profileId, credentialRef };
        delete value.apiKey;
        const provider = await send('provider.save', value);
        snapshot = await send('catalog.snapshot');
        return provider;
      }
      case 'run.start': {
        const profileId = payload.providerProfileId ?? snapshot.catalog.activeProviderProfileId;
        const provider = snapshot.providers.find(item => item.id === profileId);
        if (!provider?.hasCredential) throw new Error('Save an API key for the selected provider first');
        const credential = await loadCredential(provider.id);
        return send('run.start', { ...payload, credential });
      }
      default: {
        const result = await send(command, payload);
        if (!['run.cancel'].includes(command)) snapshot = await send('catalog.snapshot');
        return result;
      }
    }
  });

  window.once('closed', () => {
    ipcMain.removeHandler('image-tagging-command');
    worker.kill();
  });
};
