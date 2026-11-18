// 角色 Skill 的生成、覆盖合并与解析逻辑。
// 本文件为纯函数、不依赖 node 模块：主进程 ai.cjs 通过 require 使用，
// 渲染进程 TrainView 通过 Vite 直接 import（类型声明见 profile-skill.d.cts）。
//
// 约定：
// - 档案是主体：buildGeneratedSkill 从档案 character 生成基础 Skill。
// - 直接改 Skill：手写内容以字段级覆盖（skillOverrides）叠加在生成版上。
// - <custom_block name="...">…</custom_block> 是永久保留区块，档案改动也不会清除。
// - 最终提示词结构：<role_skill> JSON </role_skill> <output_contract> … </output_contract>
//   [额外区块] [custom_block …]。

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

// 从档案生成基础 Skill（以档案为主）。返回 { skill, contract }。
function buildGeneratedSkill(profile) {
  const character = profile?.character || {};
  const name = character.name || profile?.name || "桌宠";
  const dialogueOnly =
    profile?.dialogueOnly ?? profile?.character?.dialogueOnly ?? true;
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
  const contract = [
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
    ...(dialogueOnly ? fixedDialogueOnlyRules() : [])
  ].join("\n");
  return { skill, contract };
}

// 深合并：override 中的叶子值覆盖 base；override 缺失的字段沿用 base。
function deepMerge(base, override) {
  if (base === null || base === undefined || typeof base !== "object" || Array.isArray(base)) {
    return override;
  }
  if (override === null || override === undefined || typeof override !== "object" || Array.isArray(override)) {
    return override;
  }
  const out = { ...base };
  for (const key of Object.keys(override)) {
    out[key] = deepMerge(out[key], override[key]);
  }
  return out;
}

// 字段级 diff：只保留 next 与 base 不同的叶子字段；
// base 中没有的字段视为新增。返回 undefined 表示无差异。
function diffSkillField(base, next) {
  if (next === null || next === undefined || typeof next !== "object" || Array.isArray(next)) {
    return base === next ? undefined : next;
  }
  if (base === null || base === undefined || typeof base !== "object" || Array.isArray(base)) {
    return next;
  }
  const out = {};
  for (const key of Object.keys(next)) {
    if (!(key in base)) {
      out[key] = next[key];
      continue;
    }
    const sub = diffSkillField(base[key], next[key]);
    if (sub !== undefined) out[key] = sub;
  }
  return Object.keys(out).length ? out : undefined;
}

// 生成最终 Skill 文本：档案生成版 ⊕ 手写覆盖 + 额外区块 + custom_block 保留区块（末尾）。
function buildFinalSkillText(profile) {
  const generated = buildGeneratedSkill(profile);
  const overrides = profile?.skillOverrides || null;
  const customBlocks = Array.isArray(profile?.customBlocks)
    ? profile.customBlocks
    : [];
  const skill = overrides?.roleSkill
    ? deepMerge(generated.skill, overrides.roleSkill)
    : generated.skill;
  const contract = overrides?.outputContract ?? generated.contract;
  const parts = [
    "<role_skill>",
    JSON.stringify(skill, null, 2),
    "</role_skill>",
    "",
    "<output_contract>",
    contract,
    "</output_contract>"
  ];
  for (const section of overrides?.extraSections || []) {
    parts.push("", `<${section.tag}>`, section.content, `</${section.tag}>`);
  }
  for (const block of customBlocks) {
    parts.push(
      "",
      `<custom_block name="${block.name}">`,
      block.content,
      `</custom_block>`
    );
  }
  return parts.join("\n");
}

// 解析 Skill 文本（供「直接改 Skill」保存时使用）。
// 成功返回 { ok: true, skill, contract, customBlocks, extraSections }。
function parseSkillText(text) {
  const lines = String(text || "").split(/\r?\n/);
  const blocks = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const openMatch = line.match(/^\s*<([a-zA-Z_][\w.-]*)((?:\s+[^>]*)?)>\s*$/);
    if (openMatch) {
      if (current) {
        return { ok: false, error: `第 ${i + 1} 行：区块 <${current.tag}> 未闭合` };
      }
      current = { tag: openMatch[1], attrs: openMatch[2] || "", content: [] };
      continue;
    }
    const closeMatch = line.match(/^\s*<\/([a-zA-Z_][\w.-]*)>\s*$/);
    if (closeMatch) {
      if (!current) {
        return { ok: false, error: `第 ${i + 1} 行：多余的闭合标签 </${closeMatch[1]}>` };
      }
      if (closeMatch[1] !== current.tag) {
        return {
          ok: false,
          error: `第 ${i + 1} 行：</${closeMatch[1]}> 与 <${current.tag}> 不匹配`
        };
      }
      blocks.push({
        tag: current.tag,
        attrs: current.attrs,
        content: current.content.join("\n")
      });
      current = null;
      continue;
    }
    if (current) current.content.push(line);
  }
  if (current) {
    return { ok: false, error: `区块 <${current.tag}> 未闭合` };
  }

  let skill = null;
  let contract = null;
  const customBlocks = [];
  const extraSections = [];
  for (const block of blocks) {
    if (block.tag === "role_skill") {
      try {
        skill = JSON.parse(block.content.trim() || "{}");
      } catch {
        return { ok: false, error: "<role_skill> 内不是合法 JSON" };
      }
    } else if (block.tag === "output_contract") {
      contract = block.content.trim();
    } else if (block.tag === "custom_block") {
      const nameMatch = block.attrs.match(/\bname\s*=\s*"([^"]*)"/);
      const name = (nameMatch ? nameMatch[1] : "").trim();
      if (!name) {
        return { ok: false, error: "custom_block 缺少 name 属性（形如 name=\"区块名\"）" };
      }
      customBlocks.push({ name, content: block.content.trim() });
    } else {
      extraSections.push({ tag: block.tag, content: block.content });
    }
  }
  if (!skill) return { ok: false, error: "缺少 <role_skill> 区块" };
  if (contract === null) return { ok: false, error: "缺少 <output_contract> 区块" };
  return { ok: true, skill, contract, customBlocks, extraSections };
}

module.exports = {
  buildFinalSkillText,
  buildGeneratedSkill,
  deepMerge,
  diffSkillField,
  fixedDialogueOnlyRules,
  parseSkillText
};
