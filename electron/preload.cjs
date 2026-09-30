const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("deskPet", {
  getState: () => ipcRenderer.invoke("store:get"),
  updateState: (patch) => ipcRenderer.invoke("store:update", patch),
  updateStateSync: (patch) => ipcRenderer.sendSync("store:update-sync", patch),
  replaceState: (state) => ipcRenderer.invoke("store:replace", state),

  getDisplayMetrics: () => ipcRenderer.invoke("display:get-metrics"),
  getControlBounds: () => ipcRenderer.invoke("window:get-control-bounds"),
  showControl: () => ipcRenderer.invoke("window:show-control"),
  hideControl: () => ipcRenderer.invoke("window:hide-control"),
  quit: () => ipcRenderer.invoke("app:quit"),

  overlayCommand: (command) => ipcRenderer.invoke("overlay:command", command),
  hideOverlay: () => ipcRenderer.invoke("overlay:hide"),
  setOverlayMouseIgnore: (ignore) => ipcRenderer.send("overlay:ignore-mouse", ignore),

  openAuxiliary: (auxiliaryId) => ipcRenderer.invoke("auxiliary:open", auxiliaryId),
  importPetAssets: (petId) => ipcRenderer.invoke("assets:import-pet", petId),
  importSpine: (petId) => ipcRenderer.invoke("assets:import-spine", petId),
  selectSpinePart: (kind, draftId) =>
    ipcRenderer.invoke("spine:select-part", kind, draftId),
  createPetFromSpine: (draftId, parts, name) =>
    ipcRenderer.invoke("spine:create-from-parts", draftId, parts, name),
  importVoiceSample: () => ipcRenderer.invoke("assets:import-voice-sample"),
  importTrainingAudio: () => ipcRenderer.invoke("voice:transcribe-file"),

  testService: (service) => ipcRenderer.invoke("services:test", service),
  chat: (messages) => ipcRenderer.invoke("ai:chat", messages),
  speak: (text, voiceId, config) =>
    ipcRenderer.invoke("voice:speak", text, voiceId, config),
  startTraining: (profileId) => ipcRenderer.invoke("training:start", profileId),
  openTrainingFolder: (moduleId) =>
    ipcRenderer.invoke("training:open-folder", moduleId),

  getDataPaths: () => ipcRenderer.invoke("data:get-paths"),
  syncPetStore: () => ipcRenderer.invoke("data:sync-pet-store"),
  openPetStore: () => ipcRenderer.invoke("data:open-pet-store"),
  openDataFolder: () => ipcRenderer.invoke("data:open-folder"),
  exportBackup: () => ipcRenderer.invoke("data:export-backup"),
  importBackup: () => ipcRenderer.invoke("data:import-backup"),

  onStateChanged: (callback) => subscribe("store:changed", callback),
  onOverlayCommand: (callback) => subscribe("overlay:command", callback),
  onOverlayMode: (callback) => subscribe("overlay:mode", callback),
  onOverlaySettings: (callback) => subscribe("overlay:settings", callback),
  onDisplayChanged: (callback) => subscribe("display:changed", callback)
});
