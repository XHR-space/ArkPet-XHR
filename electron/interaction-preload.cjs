const { ipcRenderer } = require("electron");

function send(type, event) {
  ipcRenderer.send("overlay:pet-input", {
    type,
    button: Number(event?.button) || 0,
    buttons: Number(event?.buttons) || 0,
    screenX: Number(event?.screenX),
    screenY: Number(event?.screenY)
  });
}

function capturePointer(event) {
  try {
    event?.target?.setPointerCapture?.(event.pointerId);
  } catch {
    // A window-level listener still receives the remaining pointer events.
  }
}

function releasePointer(event) {
  try {
    event?.target?.releasePointerCapture?.(event.pointerId);
  } catch {
    // The pointer may already have been released by the browser.
  }
}

window.addEventListener(
  "pointerdown",
  (event) => {
    capturePointer(event);
    send("pointerdown", event);
  },
  true
);

window.addEventListener(
  "pointermove",
  (event) => {
    send("pointermove", event);
  },
  true
);

window.addEventListener(
  "pointerup",
  (event) => {
    send("pointerup", event);
    releasePointer(event);
  },
  true
);

window.addEventListener(
  "pointercancel",
  (event) => {
    send("pointercancel", event);
    releasePointer(event);
  },
  true
);

window.addEventListener(
  "contextmenu",
  (event) => {
    event.preventDefault();
    send("contextmenu", event);
  },
  true
);

window.addEventListener(
  "dblclick",
  (event) => {
    send("dblclick", event);
  },
  true
);
