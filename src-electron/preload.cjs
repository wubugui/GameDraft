const { ipcRenderer } = require('electron');

// Keep the game's storage and Steam integration API stable. The local page also
// has direct Node access through the BrowserWindow configuration.
const bridge = Object.freeze({
  version: 1,
  store: Object.freeze({
    readAll: (namespace) => ipcRenderer.invoke('gamedraft:store:read-all', namespace),
    write: (namespace, key, value) => ipcRenderer.invoke('gamedraft:store:write', namespace, key, value),
    remove: (namespace, key) => ipcRenderer.invoke('gamedraft:store:remove', namespace, key),
    root: () => ipcRenderer.invoke('gamedraft:store:root'),
  }),
  steam: Object.freeze({
    status: () => ipcRenderer.invoke('gamedraft:steam:status'),
    identity: () => ipcRenderer.invoke('gamedraft:steam:identity'),
    activateOverlay: (dialog) => ipcRenderer.invoke('gamedraft:steam:overlay', dialog),
    achievement: Object.freeze({
      isActivated: (id) => ipcRenderer.invoke('gamedraft:steam:achievement:is-activated', id),
      activate: (id) => ipcRenderer.invoke('gamedraft:steam:achievement:activate', id),
      clear: (id) => ipcRenderer.invoke('gamedraft:steam:achievement:clear', id),
    }),
    stats: Object.freeze({
      getInt: (name) => ipcRenderer.invoke('gamedraft:steam:stats:get-int', name),
      setInt: (name, value) => ipcRenderer.invoke('gamedraft:steam:stats:set-int', name, value),
      store: () => ipcRenderer.invoke('gamedraft:steam:stats:store'),
    }),
    cloud: Object.freeze({
      status: () => ipcRenderer.invoke('gamedraft:steam:cloud:status'),
      list: () => ipcRenderer.invoke('gamedraft:steam:cloud:list'),
      read: (name) => ipcRenderer.invoke('gamedraft:steam:cloud:read', name),
      write: (name, value) => ipcRenderer.invoke('gamedraft:steam:cloud:write', name, value),
      remove: (name) => ipcRenderer.invoke('gamedraft:steam:cloud:remove', name),
    }),
    dlc: Object.freeze({
      isInstalled: (appId) => ipcRenderer.invoke('gamedraft:steam:dlc:is-installed', appId),
    }),
  }),
});

const url = new URL(location.href);
let devOrigin = null;
try {
  const raw = process.env.GAMEDRAFT_DEV_URL;
  if (raw) {
    const configured = new URL(raw);
    if (['http:', 'https:'].includes(configured.protocol)) devOrigin = configured.origin;
  }
} catch { /* Only a valid explicit developer URL enables this bridge. */ }
if ((url.protocol === 'gamedraft:' && url.hostname === 'game')
    || (devOrigin && url.origin === devOrigin)) {
  globalThis.__GAMEDRAFT_ELECTRON__ = bridge;
}
