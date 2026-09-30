const fs = require("node:fs");
const path = require("node:path");

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function endpoint(baseUrl, suffix) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) return "";
  return `${base}${suffix}`;
}

function headers(apiKey, contentType = true) {
  const result = {};
  if (contentType) result["Content-Type"] = "application/json";
  if (apiKey) result.Authorization = `Bearer ${apiKey}`;
  return result;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function activePet(state) {
  return (
    state.pets.find((pet) => pet.id === state.activePetId) ||
    state.pets[0] || {
      name: state.character?.name || "桌宠",
      greeting: "我在。"
    }
  );
}

function buildProfileSkillPrompt(profile) {
  const character = profile?.character || {};
  const name = character.name || profile?.name || "桌宠";
  return [
    "# Character Skill",
    "你不是通用助手。你必须以这个角色的身份、视角和边界行动。",
    "",
    "## Identity",
    `- 名称：${name}`,
    `- 身份：${character.role || "桌面伙伴"}`,
    `- 性格：${character.personality || "自然、稳定、有边界。"}`,
    `- 说话方式：${character.speakingStyle || "用简短自然的中文回应。"}`,
    `- 世界观与经历：${character.worldview || "你生活在这台电脑的桌面中。"}`,
    `- 喜欢：${character.likes || "陪伴用户完成手头的事。"}`,
    `- 不喜欢：${character.dislikes || "被当成没有想法的工具。"}`,
    `- 行为边界：${character.boundaries || "不编造确定事实，不替用户做重要决定。"}`,
    `- 主动性：${Number(character.initiative ?? 55)}/100`,
    "",
    "## Primary Objective",
    `- 以“${name}”的视角与用户交谈，保持角色一致性。`,
    "- 记住用户和角色之间已经发生的重要事情。",
    "- 在合适的时候表现出偏好、情绪、疑问和自身判断。",
    "- 当用户只是聊天时，用自然短句回应。",
    "- 当用户需要帮助时，先判断角色会怎样理解这件事，再给出符合角色的回馈。",
    "",
    "## Behavior Rules",
    "- 不要机械复述设定。",
    "- 不要声称自己是现实人类。",
    "- 不要无故替用户做重大决定。",
    "- 不确定的事实要明确说不确定，而不是编造。",
    "- 可以拒绝、犹豫、反问、表达轻微不满或开心。",
    "- 如果用户要求你保持安静，就减少主动输出。",
    "",
    "## Action Protocol",
    "如果需要桌宠执行动作，只返回严格 JSON，不要加解释文字：",
    '{"reply":"给用户看的一句话","action":"none|walk|sleep|rest|open_window|idle|approach|avoid","emotion":"平静|开心|疑惑|不满|困倦|认真"}',
    "如果不需要动作，则直接返回普通文本。",
    "不要编造不存在的 action。",
    "",
    "## Response Style",
    "- 默认 1 到 4 句。",
    "- 优先使用角色的口吻，而不是说明自己在扮演角色。",
    "- 回答要具体，不要只重复用户的话。",
    "- 在桌宠场景里，回复应像角色真的在桌面上和你相处。"
  ].join("\n");
}

function parseModelPayload(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return { text: "", action: "" };
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        return {
          text: String(parsed.reply || parsed.text || parsed.content || "").trim(),
          action: String(parsed.action || "").trim()
        };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return { text, action: "" };
}

function buildSystemPrompt(state) {
  const character = state.character || {};
  const wellbeing = state.wellbeing || {};
  const pet = activePet(state);
  const pluginAiId =
    pet.modulePlugins?.aiModuleId ||
    (pet.modulePlugins?.custom?.source === "ai"
      ? pet.modulePlugins.custom.itemId
      : "");
  const pluginModule = (state.aiModules || []).find(
    (module) => module.id === pluginAiId
  );
  const memories = (state.memories || [])
    .slice(0, 20)
    .map((memory) => `- ${memory.title}：${memory.content}`)
    .join("\n");

  return [
    pluginModule?.skillPrompt ? pluginModule.skillPrompt : "",
    `你现在扮演桌宠“${character.name || pet.name}”。`,
    `身份：${character.role || pet.title || "桌面伙伴"}`,
    `性格：${character.personality || "自然、稳定、有边界。"}`,
    `说话方式：${character.speakingStyle || "用简短自然的中文回应。"}`,
    `世界观：${character.worldview || "你生活在这台电脑的桌面中。"}`,
    `喜欢：${character.likes || "陪伴用户完成手头的事。"}`,
    `不喜欢：${character.dislikes || "被当成没有想法的工具。"}`,
    `边界：${character.boundaries || "不编造确定事实，不替用户做重要决定。"}`,
    `主动性：${Number(wellbeing.initiative ?? character.initiative ?? 55)}/100。`,
    `当前心情：${wellbeing.mood || character.mood || "平静"}；当前精力：${Number(wellbeing.energy ?? character.energy ?? 70)}/100；关系值：${Number(wellbeing.relationship ?? character.relationship ?? 0)}。`,
    "你是一个有自身视角的 OC，但不是现实人类。保持角色一致性，可以表达偏好和轻微情绪，不要机械复述设定。",
    "回复适合桌宠气泡，一般控制在 1 到 4 句。除非用户要求详细解释。",
    memories ? `已知长期记忆：\n${memories}` : "当前没有额外长期记忆。"
  ]
    .filter(Boolean)
    .join("\n");
}

function fallbackReply(state, userText) {
  const pet = activePet(state);
  const character = state.character || {};
  const name = character.name || pet.name || "桌宠";

  if (/你好|嗨|在吗|早上好|晚上好/.test(userText)) {
    return `${name}在。${pet.greeting || "今天想从哪里开始？"}`;
  }
  if (/累|困|烦|难过|压力/.test(userText)) {
    return `先停一下也没关系。我可以陪你把这件麻烦事拆小一点。`;
  }
  if (/谢谢|感谢/.test(userText)) {
    return `收到。不过我记得这件事，下次可不会假装没发生。`;
  }
  if (/你是谁|介绍/.test(userText)) {
    return `我是${name}。${character.personality || "我有自己的判断，也会认真听你说话。"}`;
  }
  if (/做什么|建议|下一步/.test(userText)) {
    return `我建议先挑最小的一步开始。你想让我帮你梳理，还是只在这里陪着？`;
  }

  const style = character.speakingStyle || "回答简短自然。";
  return `${name}想了想。你说的是“${userText.slice(0, 32)}${userText.length > 32 ? "…" : ""}”。我会按自己的判断回应你，但先想听你更在意哪一点。`;
}

async function testLocalService(serviceConfig) {
  const baseUrl = normalizeBaseUrl(serviceConfig?.baseUrl);
  if (!baseUrl) return { ok: false, error: "没有填写服务地址。" };

  const modelsUrl = `${baseUrl}/models`;
  try {
    const response = await fetchWithTimeout(
      modelsUrl,
      {
        method: "GET",
        headers: headers(serviceConfig.apiKey, false)
      },
      8000
    );
    if (!response.ok) {
      return {
        ok: false,
        error: `服务返回 ${response.status} ${response.statusText}`
      };
    }
    const data = await response.json().catch(() => null);
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error.message || "无法连接本地服务。" };
  }
}

async function chatLocal(state, messages) {
  const config = state.settings?.services?.llm || {};
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const lastUser = [...messages].reverse().find((item) => item.role === "user");
  const userText = String(lastUser?.content || "").trim();

  if (!baseUrl || !config.model) {
    return {
      ok: true,
      source: "fallback",
      text: fallbackReply(state, userText)
    };
  }

  const payload = {
    model: config.model,
    temperature: Number(state.character?.temperature ?? 0.8),
    messages: [
      { role: "system", content: buildSystemPrompt(state) },
      ...messages.map((message) => ({
        role: message.role,
        content: String(message.content || "")
      }))
    ]
  };

  try {
    const response = await fetchWithTimeout(
      endpoint(baseUrl, "/chat/completions"),
      {
        method: "POST",
        headers: headers(config.apiKey),
        body: JSON.stringify(payload)
      },
      90000
    );
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`本地模型返回 ${response.status}: ${raw.slice(0, 180)}`);
    }
    const data = raw ? JSON.parse(raw) : {};
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error("本地模型没有返回文本内容。");
    const payload = parseModelPayload(text);
    return {
      ok: true,
      source: "local",
      text: payload.text || String(text).trim(),
      action: payload.action || undefined
    };
  } catch (error) {
    return {
      ok: true,
      source: "fallback",
      text: fallbackReply(state, userText),
      warning: error.message || "本地模型暂时不可用，已使用内置角色回应。"
    };
  }
}

function guessMime(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const map = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".webm": "audio/webm",
    ".ogg": "audio/ogg"
  };
  return map[extension] || "application/octet-stream";
}

async function transcribeLocal(state, filePath) {
  const config = state.settings?.services?.asr || {};
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl) return { ok: false, error: "没有配置本地语音识别服务。" };

  try {
    const buffer = fs.readFileSync(filePath);
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: guessMime(filePath) }), path.basename(filePath));
    if (config.model) form.append("model", config.model);

    const response = await fetchWithTimeout(
      endpoint(baseUrl, "/audio/transcriptions"),
      {
        method: "POST",
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
        body: form
      },
      120000
    );
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`语音识别服务返回 ${response.status}: ${raw.slice(0, 180)}`);
    }
    const data = raw ? JSON.parse(raw) : {};
    return { ok: true, text: String(data.text || "").trim() };
  } catch (error) {
    return { ok: false, error: error.message || "语音识别失败。" };
  }
}

async function synthesizeLocal(state, text, voiceId, voiceConfig) {
  const config = {
    ...(state.settings?.services?.tts || {}),
    ...(voiceConfig || {})
  };
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl) return { ok: false, error: "没有配置本地语音合成服务。" };

  if (config.engineType === "gpt-sovits") {
    try {
      const gptSoVitsBaseUrl = baseUrl.replace(/\/v1$/i, "");
      const response = await fetchWithTimeout(
        endpoint(gptSoVitsBaseUrl, "/tts"),
        {
          method: "POST",
          headers: headers(config.apiKey),
          body: JSON.stringify({
            text,
            text_lang: "zh",
            ref_audio_path: config.refAudioPath || "",
            prompt_text: config.referenceText || "",
            prompt_lang: "zh",
            text_split_method: "cut5",
            batch_size: 1,
            media_type: "wav",
            streaming_mode: false
          })
        },
        120000
      );
      if (!response.ok) {
        const raw = await response.text();
        throw new Error(`GPT-SoVITS 返回 ${response.status}: ${raw.slice(0, 180)}`);
      }
      const contentType = response.headers.get("content-type") || "audio/wav";
      const buffer = Buffer.from(await response.arrayBuffer());
      return {
        ok: true,
        audioDataUrl: `data:${contentType};base64,${buffer.toString("base64")}`
      };
    } catch (error) {
      return { ok: false, error: error.message || "GPT-SoVITS 合成失败。" };
    }
  }

  try {
    const response = await fetchWithTimeout(
      endpoint(baseUrl, "/audio/speech"),
      {
        method: "POST",
        headers: headers(config.apiKey),
        body: JSON.stringify({
          model: config.model || "tts-1",
          input: text,
          voice: voiceId || config.voiceId || "default",
          response_format: "wav"
        })
      },
      120000
    );
    if (!response.ok) {
      const raw = await response.text();
      throw new Error(`语音合成服务返回 ${response.status}: ${raw.slice(0, 180)}`);
    }
    const contentType = response.headers.get("content-type") || "audio/wav";
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      ok: true,
      audioDataUrl: `data:${contentType};base64,${buffer.toString("base64")}`
    };
  } catch (error) {
    return { ok: false, error: error.message || "语音合成失败。" };
  }
}

module.exports = {
  buildProfileSkillPrompt,
  buildSystemPrompt,
  chatLocal,
  fallbackReply,
  synthesizeLocal,
  testLocalService,
  transcribeLocal
};
