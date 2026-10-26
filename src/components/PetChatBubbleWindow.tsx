import { Send, Volume2, X } from "lucide-react";
import { useState, type CSSProperties, type FormEvent } from "react";
import { resolveDialogModule } from "../lib/dialogModules";
import { makeId } from "../lib/id";
import { useAppState } from "../state";
import type { ChatMessage } from "../types";

export function PetChatBubbleWindow({ petId }: { petId: string }) {
  const { state } = useAppState();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [audioSrc, setAudioSrc] = useState("");

  if (!state) {
    return (
      <main className="pet-chat-bubble-window pet-chat-bubble-window--loading">
        正在加载…
      </main>
    );
  }

  const pet = state.pets.find((item) => item.id === petId);
  if (!pet) {
    return (
      <main className="pet-chat-bubble-window pet-chat-bubble-window--error">
        <strong>找不到这个角色</strong>
        <span>角色可能已被收回或删除。</span>
        <button type="button" onClick={() => window.close()}>
          关闭
        </button>
      </main>
    );
  }

  const dialogModule = resolveDialogModule(state);
  const aiModuleId = pet.modulePlugins?.aiModuleId || "";
  const voiceProfileId = pet.modulePlugins?.voiceProfileId || "";
  const style = {
    "--bubble-chat-bg": dialogModule?.background || "#f7f5ef",
    "--bubble-chat-border": dialogModule?.borderColor || "#d9d7d0",
    "--bubble-chat-radius": `${dialogModule?.borderRadius ?? 8}px`,
    "--bubble-chat-text": dialogModule?.textColor || "#172033",
    "--bubble-chat-user": dialogModule?.userBubbleColor || "#edf5ff",
    "--bubble-chat-assistant": dialogModule?.assistantBubbleColor || "#ffffff",
    "--bubble-chat-font": dialogModule?.fontFamily || "Microsoft YaHei UI",
    "--bubble-chat-bg-image": dialogModule?.backgroundImageUrl
      ? `url("${dialogModule.backgroundImageUrl}")`
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

    const requestId = makeId("bubblechat");
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
        petId
      );
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantMessage.id
            ? {
                ...message,
                content: result.text,
                source: result.source,
                warning: result.warning,
                speech: result.speech
              }
            : message
        )
      );
    } catch {
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantMessage.id
            ? {
                ...message,
                content: "回复失败，请稍后重试。",
                warning: "请求失败"
              }
            : message
        )
      );
    } finally {
      unsubscribe();
      setBusy(false);
    }
  }

  async function playMessage(message: ChatMessage) {
    const result = await window.deskPet.voiceAgent.speak(message.content, {
      voiceProfileId,
      speech: message.speech
    });
    if (result.audioDataUrl) setAudioSrc(result.audioDataUrl);
  }

  return (
    <main className="pet-chat-bubble-window" style={style}>
      <header className="pet-chat-bubble-window__header">
        <strong>{pet.name}</strong>
        <button
          type="button"
          aria-label="关闭对话"
          title="关闭"
          onClick={() => window.close()}
        >
          <X size={15} />
        </button>
      </header>

      <div className="pet-chat-bubble-window__messages">
        {messages.length === 0 && (
          <span className="pet-chat-bubble-window__empty">说点什么吧。</span>
        )}
        {messages.map((message) => (
          <div
            className={`pet-chat-bubble-window__row pet-chat-bubble-window__row--${message.role}`}
            key={message.id}
          >
            <div className="pet-chat-bubble-window__message">
              <p>{message.content || (busy ? "正在想…" : "")}</p>
              {message.role === "assistant" && message.content && !busy && (
                <button
                  type="button"
                  aria-label="播放这条回复"
                  title="播放"
                  onClick={() => void playMessage(message)}
                >
                  <Volume2 size={13} />
                </button>
              )}
              {message.warning && <small>{message.warning}</small>}
            </div>
          </div>
        ))}
      </div>

      <form className="pet-chat-bubble-window__composer" onSubmit={sendMessage}>
        <input
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          placeholder="输入消息..."
        />
        <button
          type="submit"
          aria-label="发送消息"
          title="发送"
          disabled={busy || !draft.trim()}
        >
          <Send size={15} />
        </button>
      </form>

      {audioSrc && (
        <audio src={audioSrc} autoPlay onEnded={() => setAudioSrc("")} />
      )}
    </main>
  );
}
