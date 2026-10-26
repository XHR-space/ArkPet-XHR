import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuxiliaryView } from "./components/AuxiliaryView";
import { ChatWindow } from "./components/ChatWindow";
import { MultiPetOverlay } from "./components/PetOverlay";
import { PetChatBubbleWindow } from "./components/PetChatBubbleWindow";
import { StateProvider } from "./state";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element.");

const params = new URLSearchParams(window.location.search);
const view = params.get("view") || "";

function readViewId(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

let content = <App />;
if (view === "overlay") {
  document.documentElement.classList.add("overlay-document");
  document.body.classList.add("overlay-document");
  content = <MultiPetOverlay />;
} else if (view.startsWith("aux:")) {
  content = (
    <StateProvider>
      <AuxiliaryView auxiliaryId={view.slice(4)} />
    </StateProvider>
  );
} else if (view.startsWith("bubble-chat:")) {
  document.documentElement.classList.add("bubble-document");
  document.body.classList.add("bubble-document");
  content = (
    <StateProvider>
      <PetChatBubbleWindow petId={readViewId(view.slice(12))} />
    </StateProvider>
  );
} else if (view.startsWith("chat:")) {
  const chatRoute = view.slice(5);
  const separator = chatRoute.indexOf(":");
  const requestedMode =
    separator === -1 ? chatRoute : chatRoute.slice(0, separator);
  const requestedPetId =
    separator === -1 ? "" : readViewId(chatRoute.slice(separator + 1));
  content = (
    <StateProvider>
      <ChatWindow
        mode={requestedMode === "voice" ? "voice" : "text"}
        petId={requestedPetId}
      />
    </StateProvider>
  );
}

createRoot(root).render(<StrictMode>{content}</StrictMode>);
