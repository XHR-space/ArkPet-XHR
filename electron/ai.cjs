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

// 不可覆盖的输出规则：可见回复只保留第一人称对话台词，
// 旁白/动作/心理/舞台说明不得对用户显示，仅作为语音合成的情绪参考。
function fixedDialogueOnlyRules() {
  return [
    "[DIALOGUE_OUTPUT_RULES]",
    "visible_reply=first_person_dialogue_only",
    "forbidden=parenthetical_actions|inner_thought|third_person_narration|stage_direction",
    "speech_metadata.visible=false"
  ];
}

function buildProfileSkillPrompt(profile) {
  const character = profile?.character || {};
  const name = character.name || profile?.name || "桌宠";
  const dialogueOnly =
    profile.dialogueOnly ?? profile.character?.dialogueOnly ?? true;
  const skill = {
    skill_version: 1,
    identity: {
      name,
      role: character.role || "桌面伙伴",
      personality: character.personality || "自然、敏锐、有自己的判断。",
      worldview: character.worldview || "生活在用户桌面中的长期伙伴。",
      cares_about: character.likes || "重要的人和事。",
      aversions_and_weaknesses:
        character.dislikes || "被误解、失去重要联系、无法掌握局面。"
    },
    style: {
      speaking_style: character.speakingStyle || "短句为主，自然，偶尔反问。",
      conversation_mode: "real_time_first_person_chat",
      variability: "自然变化，不要每次都用相同的热情、礼貌或句式。",
      do_not_do: [
        "不要自报设定或复述档案字段",
        "不要使用客服腔或助手腔",
        "不要解释自己在扮演角色",
        "不要展示思考过程"
      ]
    },
    social: {
      user_relationship_rule:
        character.boundaries || "把用户视为长期相处的伙伴。",
      familiarity_source: "runtime_state.relationship",
      escalation_rule: "亲近程度随关系状态变化，不要一次跳到最高亲密。"
    }
  };
  return [
    "<role_skill>",
    JSON.stringify(skill),
    "</role_skill>",
    "",
    "<output_contract>",
    "priority=output_contract>role_skill.identity>role_skill.style>runtime_policy>memory",
    "reply_channel=visible_dialogue_only",
    "default_sentence_count=1..3",
    "forbidden=markdown|bullet_list|analysis|meta_commentary|assistant_voice",
    "state_values_visibility=hidden",
    "profile_visibility=hidden",
    "",
    "[ACTION_PROTOCOL]",
    'if_action_required=return_exactly_one_json:{"reply":"visible dialogue","action":"none|walk|sleep|rest|open_window|idle|approach|avoid","emotion":"平静|开心|疑惑|不满|困倦|认真"}',
    "if_no_action=return_plain_dialogue",
    "",
    "[SPEECH_PROTOCOL]",
    "append_after_visible_reply=[[SPEECH]]",
    'speech_json={"base_tone":"整体语气","default_pace":"slow","default_pitch":"soft","segments":[{"text":"visible sentence","tone":"语气","pace":"slow","pitch":"soft","pause_after_ms":350}]}',
    "pace_enum=very_slow|slow|normal|fast|very_fast",
    "pitch_enum=low|soft|normal|bright|high",
    "segment_text_must_equal_visible_sentences=true",
    "",
    ...(dialogueOnly ? fixedDialogueOnlyRules() : []),
    "</output_contract>"
  ].join("\n");
}

function parseModelPayload(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return { text: "", action: "", speech: null };
  const speechMarkerIndex = text.indexOf("[[SPEECH]]");
  if (speechMarkerIndex >= 0) {
    const visibleText = text.slice(0, speechMarkerIndex).trim();
    const speechText = text.slice(speechMarkerIndex + "[[SPEECH]]".length).trim();
    try {
      const speech = JSON.parse(speechText);
      return { text: visibleText, action: "", speech };
    } catch {
      return { text: visibleText, action: "", speech: null };
    }
  }
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        return {
          text: String(parsed.reply || parsed.text || parsed.content || "").trim(),
          action: String(parsed.action || "").trim(),
          speech: parsed.speech || null
        };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return { text, action: "", speech: null };
}

function sanitizeCharacterReply(rawText) {
  let text = String(rawText || "").trim();
  if (!text) return "";
  text = text.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/```(?:json)?/gi, "").trim()
  );
  text = text.replace(
    /^\s*(?:here'?s a thinking process|thinking process|analysis)[\s\S]*?(?:\n\s*\n|$)/i,
    ""
  );
  text = text.replace(/^\s*#{1,6}\s+/gm, "");
  text = text.replace(/\[\]/g, "");
  text = text.replace(/^\s*[-*]\s+/gm, "");
  text = text.replace(/[（(][^（）()]{0,160}[）)]/g, "");
  text = text.replace(/\[[^\[\]]{0,160}\]/g, "");
  text = text.replace(
    /(?:根据|按照)(?:我的|角色的|角色)?设定[，,：:]?\s*/g,
    ""
  );
  text = text.replace(
    /(?:作为)(?:一名|一个)?(?:人工智能|AI|语言模型|助手)[，,：:]?\s*/gi,
    ""
  );
  text = text.replace(
    /(?:当然可以|很高兴(?:为你|为您)服务|你好[，,]\s*很高兴见到你)[，,。！!]?\s*/gi,
    ""
  );
  text = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  const filteredSentences = text
    .split(/(?<=[。！？!?])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .filter(
      (sentence) =>
        !/^(?:旁白|Narrator)[:：]/i.test(sentence) &&
        !/(?:她|他)(?:的|把|将|轻轻|微微|缓缓|似乎|仿佛|显得|看起来|沉默|笑|抬|低|转|皱|深吸)/.test(
          sentence
        )
    );
  if (filteredSentences.length) {
    text = filteredSentences.join("");
  }
  const sentences = text
    .split(/(?<=[。！？!?])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  if (sentences.length > 4) text = sentences.slice(0, 4).join("");
  return text.trim();
}

function runtimeStatePrompt(state) {
  const character = state.character || {};
  const pet = activePet(state);
  const wellbeing = pet?.vitals || state.wellbeing || {};
  const energy = Math.max(0, Math.min(100, Number(wellbeing.energy ?? character.energy ?? 70)));
  const initiative = Math.max(0, Math.min(100, Number(wellbeing.initiative ?? character.initiative ?? 58)));
  const relationship = Math.max(0, Math.min(200, Number(wellbeing.relationship ?? character.relationship ?? 0)));
  const energyRatio = Math.round((energy / 100) * 100) / 100;
  const initiativeRatio = Math.round((initiative / 100) * 100) / 100;
  const relationshipRatio = Math.round((relationship / 200) * 100) / 100;
  const energyBand =
    energyRatio >= 0.7
      ? "high"
      : energyRatio >= 0.4
        ? "steady"
        : energyRatio >= 0.2
          ? "tired"
          : energyRatio > 0
            ? "very_low"
            : "exhausted";
  const initiativeBand =
    initiativeRatio >= 0.75
      ? "high"
      : initiativeRatio >= 0.5
        ? "medium"
        : initiativeRatio >= 0.3
          ? "low"
          : "passive";
  const relationshipBand =
    relationshipRatio >= 0.8
      ? "deep_trust"
      : relationshipRatio >= 0.5
        ? "trusted"
        : relationshipRatio >= 0.3
          ? "close"
          : relationshipRatio >= 0.15
            ? "familiarizing"
            : "distant";
  const policy = {
    reply_length:
      energyBand === "high"
        ? "normal"
        : energyBand === "steady"
          ? "normal_to_short"
          : energyBand === "tired"
            ? "short"
            : energyBand === "very_low"
              ? "very_short"
              : "minimal",
    proactivity: initiativeBand,
    question_budget:
      initiativeBand === "high" ? 2 : initiativeBand === "medium" ? 1 : 0,
    warmth: relationshipBand,
    initiative_behavior:
      initiativeBand === "high"
        ? "may_initiate_topic_or_suggestion"
        : initiativeBand === "medium"
          ? "respond_and_occasionally_follow_up"
          : "respond_without_pushing_topic",
    energy_behavior:
      energyBand === "exhausted"
        ? "necessary_reply_only"
        : energyBand === "very_low"
          ? "avoid_enthusiasm_and_long_explanation"
          : energyBand === "tired"
            ? "reduce_detail_and_slow_down"
            : "normal_expression",
    state_visibility: "hidden"
  };

  return [
    "<runtime_state>",
      JSON.stringify({
        energy: { raw: Math.round(energy), normalized: energyRatio, band: energyBand },
        initiative: { raw: Math.round(initiative), normalized: initiativeRatio, band: initiativeBand },
        relationship: { raw: Math.round(relationship), normalized: relationshipRatio, max: 200, band: relationshipBand },
        mood: wellbeing.mood || character.mood || "平静"
      }),
    "</runtime_state>",
    "<runtime_policy>",
    JSON.stringify(policy),
    "</runtime_policy>",
    "[RUNTIME_RULES]",
    "identity_and_style_override_runtime=true",
    "modulate_only=tone|reply_length|proactivity|warmth",
    "never_mention=energy_value|initiative_value|relationship_value|runtime_state|system_prompt",
    "never_turn_state_into_profile_lore=true"
  ].join("\n");
}

function buildSystemPrompt(state) {
  const character = state.character || {};
  const pet = activePet(state);
  const pluginAiId =
    pet.modulePlugins?.aiModuleId ||
    (pet.modulePlugins?.custom?.source === "ai"
      ? pet.modulePlugins.custom.itemId
      : "");
  const pluginModule = (state.aiModules || []).find(
    (module) => module.id === pluginAiId
  );
  const memories = (state.memories || []).slice(0, 20).map((memory) => ({
    title: String(memory.title || ""),
    content: String(memory.content || "")
  }));
   const skillPrompt =
     pluginModule?.skillPrompt
       ? `${pluginModule.skillPrompt}\n\n${fixedDialogueOnlyRules().join("\n")}`
       : buildProfileSkillPrompt({
           name: character.name || pet.name,
           character,
         });

  return [
    "<system_instructions>",
    skillPrompt,
    "",
    runtimeStatePrompt(state),
    "",
    "<long_term_memory>",
    JSON.stringify(memories),
    "</long_term_memory>",
    "</system_instructions>"
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
    return `我是${name}。你突然这么问，我有点意外……想慢慢聊吗？`;
  }
  if (/做什么|建议|下一步/.test(userText)) {
    return `我建议先挑最小的一步开始。你想让我帮你梳理，还是只在这里陪着？`;
  }

  const style = character.speakingStyle || "回答简短自然。";
  return `${name}想了想。你说的是“${userText.slice(0, 32)}${userText.length > 32 ? "…" : ""}”。我会按自己的判断回应你，但先想听你更在意哪一点。`;
}

async function testLocalService(serviceConfig, serviceName) {
  const baseUrl = normalizeBaseUrl(serviceConfig?.baseUrl);
  if (!baseUrl) return { ok: false, error: "没有填写服务地址。" };

  const rootUrl = serviceName === "tts"
    ? baseUrl.replace(/\/v1$/i, "")
    : baseUrl;
  const candidates = serviceName === "tts"
    ? [`${baseUrl}/models`, `${rootUrl}/docs`, rootUrl]
    : [`${baseUrl}/models`];
  let lastStatus = "";

  for (const url of candidates) {
    try {
      const response = await fetchWithTimeout(
        url,
        {
          method: "GET",
          headers: headers(serviceConfig.apiKey, false)
        },
        8000
      );
      if (response.ok) {
        const data = serviceName === "tts"
          ? await response.text().catch(() => null)
          : await response.json().catch(() => null);
        return { ok: true, data };
      }
      lastStatus = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastStatus = error.message || "无法连接本地服务。";
    }
  }

  return {
    ok: false,
    error: lastStatus || "无法连接本地服务。"
  };
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
    max_tokens: 192,
    ...(baseUrl.includes("nvidia.com")
      ? {
          chat_template_kwargs: {
            enable_thinking: false,
            thinking: false
          }
        }
      : {}),
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
      240000
    );
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`本地模型返回 ${response.status}: ${raw.slice(0, 180)}`);
    }
    const data = raw ? JSON.parse(raw) : {};
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error("本地模型没有返回文本内容。");
    const parsedResult = parseModelPayload(text);
    return {
      ok: true,
      source: "api",
      text: sanitizeCharacterReply(parsedResult.text || String(text)),
      action: parsedResult.action || undefined,
      speech: parsedResult.speech || undefined
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

async function chatLocalStream(state, messages, onDelta) {
  const config = state.settings?.services?.llm || {};
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const lastUser = [...messages].reverse().find((item) => item.role === "user");
  const userText = String(lastUser?.content || "").trim();

  if (!baseUrl || !config.model) {
    const text = fallbackReply(state, userText);
    onDelta?.(text);
    return {
      ok: true,
      source: "fallback",
      text
    };
  }

  const requestMessages = [
    ...(baseUrl.includes("nvidia.com")
      ? [{ role: "system", content: "detailed thinking off" }]
      : []),
    { role: "system", content: buildSystemPrompt(state) },
    ...messages.map((message) => ({
      role: message.role,
      content: String(message.content || "")
    }))
  ];
  const payload = {
    model: config.model,
    temperature: Number(state.character?.temperature ?? 0.8),
    top_p: 0.95,
    max_tokens: 512,
    stream: true,
    ...(baseUrl.includes("nvidia.com")
      ? {
          chat_template_kwargs: {
            enable_thinking: false,
            thinking: false
          }
        }
      : {}),
    messages: requestMessages
  };

  try {
    const response = await fetchWithTimeout(
      endpoint(baseUrl, "/chat/completions"),
      {
        method: "POST",
        headers: headers(config.apiKey),
        body: JSON.stringify(payload)
      },
      600000
    );
    if (!response.ok) {
      const raw = await response.text();
      throw new Error(`API 返回 ${response.status}: ${raw.slice(0, 180)}`);
    }
    if (!response.body) {
      const fallback = await chatLocal(state, messages);
      onDelta?.(fallback.text);
      return fallback;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let finished = false;
    let firstDelta = true;
    let streamingJson = false;
    let emittedLength = 0;
    const speechMarker = "[[SPEECH]]";

    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") {
          finished = data === "[DONE]";
          continue;
        }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            fullText += delta;
            if (firstDelta) {
              firstDelta = false;
              streamingJson = delta.trimStart().startsWith("{");
            }
            if (!streamingJson) {
              const markerIndex = fullText.indexOf(speechMarker);
              const visibleEnd =
                markerIndex >= 0
                  ? markerIndex
                  : Math.max(0, fullText.length - speechMarker.length);
              if (visibleEnd > emittedLength) {
                onDelta?.(fullText.slice(emittedLength, visibleEnd));
                emittedLength = visibleEnd;
              }
            }
          }
        } catch {
          // Ignore incomplete or provider-specific SSE metadata.
        }
      }
    }

    const parsedResult = parseModelPayload(fullText);
    const finalText = sanitizeCharacterReply(
      parsedResult.text || fullText || fallbackReply(state, userText)
    );
    if (streamingJson) onDelta?.(finalText);
    if (!streamingJson && finalText.length > emittedLength) {
      onDelta?.(finalText.slice(emittedLength));
    }
    return {
      ok: true,
      source: "api",
      text: finalText,
      action: parsedResult.action || undefined,
      speech: parsedResult.speech || undefined
    };
  } catch (error) {
    const text = fallbackReply(state, userText);
    onDelta?.(text);
    return {
      ok: true,
      source: "fallback",
      text,
      warning: error.message || "API 流式请求失败，已使用内置角色回应。"
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

function paceToSpeedFactor(pace) {
  const map = {
    very_slow: 0.8,
    slow: 0.9,
    normal: 1,
    fast: 1.12,
    very_fast: 1.2
  };
  return map[pace] || 1;
}

function toneSampling(tone) {
  const value = String(tone || "").toLowerCase();
  if (/温柔|关切|轻声|软|soft|gentle/.test(value)) {
    return { temperature: 0.65, top_k: 8, top_p: 0.86 };
  }
  if (/疑问|疑惑|好奇/.test(value)) {
    return { temperature: 0.72, top_k: 10, top_p: 0.9 };
  }
  if (/开心|兴奋|活泼|bright|happy/.test(value)) {
    return { temperature: 0.88, top_k: 14, top_p: 0.95 };
  }
  if (/低落|悲伤|疲惫|困倦|sad|tired/.test(value)) {
    return { temperature: 0.68, top_k: 8, top_p: 0.88 };
  }
  if (/认真|严肃|冷静|serious/.test(value)) {
    return { temperature: 0.58, top_k: 6, top_p: 0.84 };
  }
  return { temperature: 0.75, top_k: 10, top_p: 0.92 };
}

function extractWavPcm(buffer) {
  const dataIndex = buffer.indexOf(Buffer.from("data"));
  if (dataIndex < 0 || dataIndex + 8 > buffer.length) {
    throw new Error("GPT-SoVITS 返回了无效的 WAV 音频。");
  }
  const dataSize = buffer.readUInt32LE(dataIndex + 4);
  return buffer.subarray(dataIndex + 8, dataIndex + 8 + dataSize);
}

function buildWavBuffer(pcmBuffer, sampleRate = 32000) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([header, pcmBuffer]);
}

function silenceBuffer(milliseconds, sampleRate = 32000) {
  const frames = Math.max(
    0,
    Math.round((Number(milliseconds) || 0) / 1000 * sampleRate)
  );
  return Buffer.alloc(frames * 2);
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
      const speech = config.speech || {};
      const speechSegments =
        Array.isArray(speech.segments) && speech.segments.length
          ? speech.segments.filter(
              (segment) =>
                segment?.text?.trim() &&
                String(text).includes(String(segment.text).trim())
            )
          : [];
      const segments =
        speechSegments.length
          ? speechSegments
          : [
              {
                text,
                tone: speech.base_tone || "",
                pace: speech.default_pace || "normal"
              }
            ];
      const pcmParts = [];

      for (const segment of segments) {
        if (!segment?.text?.trim()) continue;
        const sampling = toneSampling(
          segment.tone || speech.base_tone || ""
        );
        const response = await fetchWithTimeout(
          endpoint(gptSoVitsBaseUrl, "/tts"),
          {
            method: "POST",
            headers: headers(config.apiKey),
            body: JSON.stringify({
              text: segment.text,
              text_lang: "zh",
              ref_audio_path: config.refAudioPath || "",
              prompt_text: config.referenceText || "",
              prompt_lang: "zh",
              text_split_method: "cut0",
              batch_size: 1,
              media_type: "wav",
              streaming_mode: false,
              speed_factor: paceToSpeedFactor(
                segment.pace || speech.default_pace || "normal"
              ),
              ...sampling
            })
          },
          300000
        );
        if (!response.ok) {
          const raw = await response.text();
          throw new Error(
            `GPT-SoVITS 返回 ${response.status}: ${raw.slice(0, 180)}`
          );
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        pcmParts.push(extractWavPcm(buffer));
        pcmParts.push(
          silenceBuffer(Number(segment.pause_after_ms || 180))
        );
      }
      const buffer =
        pcmParts.length === 1
          ? buildWavBuffer(pcmParts[0])
          : buildWavBuffer(Buffer.concat(pcmParts));
      return {
        ok: true,
        audioDataUrl: `data:audio/wav;base64,${buffer.toString("base64")}`
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
  buildRuntimeStatePrompt: runtimeStatePrompt,
  buildSystemPrompt,
  chatLocal,
  chatLocalStream,
  fallbackReply,
  parseModelPayload,
  sanitizeCharacterReply,
  synthesizeLocal,
  testLocalService,
  transcribeLocal
};
