const { contextBridge, ipcRenderer } = require("electron");

// 外部模组专用桥接：模组页面只能通过 window.arkpet 调用软件能力，
// 拿不到 Node、Electron 内部对象，也拿不到完整应用状态。
const invoke = (channel, ...args) =>
  ipcRenderer.invoke(`module:${channel}`, ...args);

function subscribe(channel, callback) {
  if (typeof callback !== "function") return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

contextBridge.exposeInMainWorld("arkpet", {
  apiVersion: 1,
  module: {
    info: () => invoke("info")
  },
  app: {
    version: () => invoke("app-version"),
    openExternal: (url) => invoke("open-external", url),
    notify: (title, body) => invoke("notify", title, body)
  },
  pets: {
    list: () => invoke("pets-list"),
    active: () => invoke("pets-active"),
    onChanged: (callback) => subscribe("module:pets-changed", callback)
  },
  pet: {
    command: (command) => invoke("pet-command", command)
  },
  chat: {
    ask: (text, petId) => invoke("chat-ask", text, petId)
  },
  voice: {
    speak: (text) => invoke("voice-speak", text)
  },
  storage: {
    keys: () => invoke("storage-keys"),
    get: (key) => invoke("storage-get", key),
    set: (key, value) => invoke("storage-set", key, value),
    remove: (key) => invoke("storage-remove", key)
  },
  activity: {
    log: (text) => invoke("activity-log", text)
  },
  ui: {
    close: () => invoke("ui-close"),
    setSize: (width, height) => invoke("ui-set-size", width, height),
    setTitle: (title) => invoke("ui-set-title", title)
  }
});
