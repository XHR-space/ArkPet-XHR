// 朗读前剥离给 AI 看的语音元数据（[[SPEECH]] / speech_json / 旁白 / 动作描写），
// 保证 TTS 只合成可见台词。
function stripSpeechMetadata(input) {
  let text = String(input || "");
  text = text.split(/\[\[SPEECH\]\]/i)[0];
  const speechJsonAt = text.search(/speech_json\s*=/i);
  if (speechJsonAt >= 0) text = text.slice(0, speechJsonAt);
  text = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:旁白|Narrator)\s*[:：][^\n]*/i, "").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/[（(][^（）()]{0,80}[）)]/g, "")
    .replace(/\[(?:pause|breath|tone|emotion|speed|pitch)[^\]]{0,40}\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

class VoiceAgent {
  constructor({ transcribe, reply, speak }) {
    this.transcribeProvider = transcribe;
    this.replyProvider = reply;
    this.speakProvider = speak;
  }

  async transcribe(audioBytes, options = {}) {
    return this.transcribeProvider(audioBytes, options);
  }

  async reply(text, options = {}) {
    return this.replyProvider(text, options);
  }

  async speak(text, options = {}) {
    const cleanText = stripSpeechMetadata(text);
    return this.speakProvider(cleanText, options);
  }

  async onUserAudio(audioBytes, options = {}) {
    const transcription = await this.transcribe(audioBytes, options);
    if (!transcription.ok || !transcription.text) {
      return {
        ok: false,
        error: transcription.error || "没有识别到有效语音。",
        transcription
      };
    }
    const reply = await this.reply(transcription.text, options);
    if (!reply.ok || !reply.text) {
      return {
        ok: false,
        error: reply.error || reply.warning || "对话模型没有返回文本。",
        transcription,
        reply
      };
    }
    const speech = await this.speak(reply.text, options);
    return {
      ok: speech.ok,
      transcript: transcription.text,
      reply: reply.text,
      source: reply.source,
      warning: reply.warning,
      audioDataUrl: speech.audioDataUrl,
      error: speech.error
    };
  }
}

module.exports = {
  VoiceAgent
};
