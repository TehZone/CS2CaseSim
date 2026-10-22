const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  loadSave: () => ipcRenderer.invoke('save:load'),
  writeSave: (text) => ipcRenderer.invoke('save:write', text),
  writeSaveSync: (text) => ipcRenderer.sendSync('save:writeSync', text),
  deleteSave: () => ipcRenderer.invoke('save:delete'),
  refreshPrices: () => ipcRenderer.invoke('prices:refresh'),
  resetPrices: () => ipcRenderer.invoke('prices:reset'),
  onPriceProgress: (cb) => ipcRenderer.on('prices:progress', (_e, msg) => cb(msg)),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  clearImageCache: () => ipcRenderer.invoke('app:clearImageCache'),
  info: () => ipcRenderer.invoke('app:info'),
  cs2Status: () => ipcRenderer.invoke('cs2:status'),
  cs2Prepare: (req) => ipcRenderer.invoke('cs2:prepare', req),
  cs2Clear: () => ipcRenderer.invoke('cs2:clear'),
  cs2Sounds: () => ipcRenderer.invoke('cs2:sounds'),
  cs2Sticker: (material) => ipcRenderer.invoke('cs2:sticker', material),
  cs2VanityMaps: () => ipcRenderer.invoke('cs2:vanityMaps'),
  cs2Vanity: (id) => ipcRenderer.invoke('cs2:vanity', id),
  cs2FirstPerson: (weapon) => ipcRenderer.invoke('cs2:firstPerson', weapon),
  cs2Crate: (id) => ipcRenderer.invoke('cs2:crate', id),
});
