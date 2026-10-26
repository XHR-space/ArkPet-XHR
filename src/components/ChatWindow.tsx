import { Send, Volume2, X } from "lucide-react";
import { useState, type CSSProperties, type FormEvent } from "react";
import { makeId } from "../lib/id";
import { useAppState } from "../state";
import type { ChatMessage } from "../types";
import { resolveDialogModule } from "../lib/dialogModules";
import { VoiceAgentPanel } from "./VoicePanel";

export function ChatWindow({
  mode,
  petId
}: {
  mode: "text" | "voice";
  petId?: string;
}) {
  const { state } = useAppState();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [audioSrc, setAudioSrc] = useState("");

  if (!state) return null;
  const dialogModule = resolveDialogModule(state);
  const requestedPet = petId
    ? state.pets.find((pet) => pet.id === petId)
    : undefined;
  if (petId && !requestedPet) {
    return (
      <main className="chat-window-shell">
        <header className="chat-window-header">
          <strong>角色不可用</strong>
          <button type="button" aria-label="关闭对话" title="关闭" onClick={() => window.close()}>
            <X size={17} />
          </button>
        </header>
        <div className="chat-window-messages" role="alert">
          <div className="chat-window-row">
            <div className="chat-window-bubble">
              <p>角色不存在或已删除，无法继续对话。</p>
            </div>
          </div>
        </div>
      </main>
    );
  }
  const chatPet =
    requestedPet ||
    state.pets.find((pet) => pet.id === state.activePetId) ||
    state.pets[0];
  const voiceProfileId = chatPet?.modulePlugins?.voiceProfileId || "";
  const aiModuleId = chatPet?.modulePlugins?.aiModuleId || "";
  const style = {
    "--chat-bg": dialogModule?.background || "#f7f5ef",
    "--chat-border": dialogModule?.borderColor || "#d9d7d0",
    "--chat-radius": `${dialogModule?.borderRadius ?? 8}px`,
    "--chat-text": dialogModule?.textColor || "#172033",
    "--chat-user": dialogModule?.userBubbleColor || "#edf5ff",
    "--chat-assistant": dialogModule?.assistantBubbleColor || "#ffffff",
    "--chat-font": dialogModule?.fontFamily || "Microsoft YaHei UI",
    "--chat-bg-image": dialogModule?.backgroundImageUrl
      ? `url("${dialogModule.backgroundImageUrl}")`
      : "none",
    "--chat-user-image": dialogModule?.userBubbleImageUrl
      ? `url("${dialogModule.userBubbleImageUrl}")`
      : "none",
    "--chat-assistant-image": dialogModule?.assistantBubbleImageUrl
      ? `url("${dialogModule.assistantBubbleImageUrl}")`
      : "none"
  } as CSSProperties;

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    const userMessage: ChatMessage = {
      id: makeId("chat"),
      role: "user",
      content,
      createdAt: new Date().toISOString()
    };
    const assistantMessage: ChatMessage = {
      id: makeId("chat"),
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString()
    };
    const next = [...messages, userMessage];
    setMessages([...next, assistantMessage]);
    setDraft("");
    setBusy(true);
    const requestId = makeId("chatreq");
    const unsubscribe = window.deskPet.onChatStream(
      ({ delta, requestId: incomingId }) => {
        if (!delta) return;
        if (incomingId && incomingId !== requestId) return;
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantMessage.id
              ? { ...message, content: `${message.content}${delta}` }
              : message
          )
        );
      }
    );
    try {
      const result = await window.deskPet.chatStream(
        next.map((message) => ({
          role: message.role,
          content: message.content
        })),
        aiModuleId,
        requestId,
        chatPet?.id
      );
      setMessages([
        ...next,
        {
          ...assistantMessage,
          content: result.text,
          source: result.source,
          warning: result.warning,
          speech: result.speech
        }
      ]);
    } finally {
      unsubscribe();
      setBusy(false);
    }
  }

  async function speakMessage(message: ChatMessage) {
    const result = await window.deskPet.voiceAgent.speak(message.content, {
      voiceProfileId,
      speech: message.speech
    });
    if (result.audioDataUrl) setAudioSrc(result.audioDataUrl);
  }

  return (
    <main className="chat-window-shell" style={style}>
      <header className="chat-window-header">
        <strong>{chatPet?.name || "桌宠"}</strong>
        <button type="button" aria-label="关闭对话" title="关闭" onClick={() => window.close()}>
          <X size={17} />
        </button>
      </header>

      {mode === "voice" ? (
        <div className="chat-window-voice">
          <VoiceAgentPanel voiceProfileId={voiceProfileId} />
        </div>
      ) : (
        <>
          <div className="chat-window-messages">
            {messages.map((message) => (
              <div
                className={
                  message.role === "user"
                    ? "chat-window-row chat-window-row--user"
                    : "chat-window-row"
                }
                key={message.id}
              >
                <div className="chat-window-bubble">
                  <p>{message.content}</p>
                  {message.role === "assistant" && message.content && (
                    <button type="button" onClick={() => void speakMessage(message)}>
                      <Volume2 size={14} />
                      播放
                    </button>
                  )}
                  {message.warning && <small>{message.warning}</small>}
                </div>
              </div>
            ))}
          </div>
          <form className="chat-window-composer" onSubmit={sendMessage}>
            <input
              value={draft}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              placeholder="说点什么..."
            />
            <button type="submit" disabled={busy || !draft.trim()}>
              <Send size={16} />
            </button>
          </form>
        </>
      )}
      {audioSrc && <audio src={audioSrc} autoPlay controls />}
    </main>
  );
}
