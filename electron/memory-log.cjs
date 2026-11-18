"use strict";

/*
 * 角色档案记忆日志：纯函数数据层。
 *
 * 记忆结构（挂在 TrainingProfile.memoryLog 上，各档案独立）：
 *   { summary?: string; recent: MemoryLogEntry[] }
 * 每条日志：
 *   { id, kind: "dialogue" | "behavior" | "module", source?, text, createdAt }
 *
 * 压缩策略：
 *   - recent 满 50 条自动压缩：最旧的 (总数 - 20) 条并进摘要，保留最近 20 条原文。
 *   - 手动压缩：全部原文并进摘要，recent 清空。
 *   - 压缩文本由调用方拿模型生成，这里只负责数据变换与提示词构建。
 */

const crypto = require("node:crypto");

const COMPRESS_THRESHOLD = 50;
const KEEP_RECENT = 20;
const MAX_RECENT = 400; // 硬上限：即使压缩一直失败，日志也不会无限膨胀
const ENTRY_TEXT_LIMIT = 4000;

const SUMMARIZE_SYSTEM =
  "你是桌宠的记忆整理助手。根据长期摘要与最近日志，提炼与用户当前消息最相关的记忆上下文。只输出简洁的中文要点（每条一行，最多 5 条）；没有相关内容时只输出“无”。";

const COMPRESS_SYSTEM =
  "你是桌宠的记忆整理助手。把互动日志压缩成新的长期记忆摘要。只输出摘要正文，不要解释。保留人名、关系、承诺、喜好、重要事件与关键数字；合并重复、删除琐碎内容。摘要用中文，不超过 300 字。";

function createEntry(kind, text, source, createdAt) {
  const normalizedKind =
    kind === "behavior" || kind === "module" ? kind : "dialogue";
  return {
    id: crypto.randomUUID(),
    kind: normalizedKind,
    ...(source ? { source: String(source).slice(0, 64) } : {}),
    text: String(text || "").slice(0, ENTRY_TEXT_LIMIT),
    createdAt: createdAt || new Date().toISOString()
  };
}

function isEntryLike(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.text === "string" &&
      value.text.trim()
  );
}

function normalizeEntry(value) {
  return {
    id: String(value.id || crypto.randomUUID()),
    kind:
      value.kind === "behavior" || value.kind === "module"
        ? value.kind
        : "dialogue",
    ...(value.source ? { source: String(value.source).slice(0, 64) } : {}),
    text: String(value.text || "").slice(0, ENTRY_TEXT_LIMIT),
    createdAt: String(value.createdAt || new Date().toISOString())
  };
}

function normalizeMemoryLog(raw) {
  const recent = Array.isArray(raw?.recent) ? raw.recent : [];
  return {
    summary: typeof raw?.summary === "string" ? raw.summary : "",
    recent: recent
      .filter(isEntryLike)
      .map(normalizeEntry)
      .slice(-MAX_RECENT)
  };
}

function emptyMemoryLog() {
  return { summary: "", recent: [] };
}

function appendEntry(memory, entry) {
  const base = normalizeMemoryLog(memory);
  return {
    summary: base.summary,
    recent: [...base.recent, normalizeEntry(entry)].slice(-MAX_RECENT)
  };
}

function shouldCompress(memory) {
  return (memory?.recent?.length || 0) >= COMPRESS_THRESHOLD;
}

// 自动压缩计划：返回要压进摘要的最老条目与它们的 id 集合。
// 应用时按 id 删除，即使压缩期间又追加了新日志也不会误删。
function compressPlan(memory) {
  const recent = memory?.recent || [];
  if (recent.length < COMPRESS_THRESHOLD) return null;
  const count = recent.length - KEEP_RECENT;
  const entries = recent.slice(0, count);
  return {
    entries,
    removedIds: new Set(entries.map((entry) => entry.id))
  };
}

// 手动压缩计划：全部原文压进摘要。
function manualCompressPlan(memory) {
  const recent = memory?.recent || [];
  return {
    entries: recent.slice(),
    removedIds: new Set(recent.map((entry) => entry.id))
  };
}

function applyCompression(memory, newSummary, removedIds) {
  const base = normalizeMemoryLog(memory);
  const ids =
    removedIds instanceof Set ? removedIds : new Set(removedIds || []);
  const summary = String(newSummary || "").trim().slice(0, 4000);
  return {
    summary: summary || base.summary,
    recent: base.recent.filter((entry) => !ids.has(entry.id))
  };
}

function formatEntries(entries) {
  return (entries || [])
    .map((entry) => {
      const label =
        entry.kind === "behavior"
          ? "行为"
          : entry.kind === "module"
            ? "模组"
            : "对话";
      const time = String(entry.createdAt || "")
        .slice(0, 19)
        .replace("T", " ");
      return `[${label}${time ? " " + time : ""}] ${entry.text}`;
    })
    .join("\n");
}

// 两步参考第一步：让模型把「摘要 + 最近日志」提炼成与当前消息相关的记忆上下文。
function buildMemoryContextPrompt(memory, userText) {
  const base = normalizeMemoryLog(memory);
  const summary = base.summary.trim() ? base.summary : "（暂无）";
  const recentText = base.recent.length
    ? formatEntries(base.recent.slice(-30))
    : "（暂无）";
  return [
    "下面是这位角色与用户的互动记忆：",
    "",
    "【长期摘要】",
    summary,
    "",
    "【最近日志】",
    recentText,
    "",
    `用户当前消息：${String(userText || "").slice(0, 2000)}`,
    "",
    "请提炼与用户当前消息最相关的记忆上下文（称呼、约定、偏好、进行中的事等），用简洁中文要点列出，每条一行，最多 5 条；没有相关内容时只输出“无”。"
  ].join("\n");
}

function buildCompressPrompt(summary, entries) {
  return [
    "把下面的互动日志压缩成新的长期记忆摘要。",
    "",
    "【已有摘要】",
    summary && String(summary).trim() ? String(summary) : "（暂无）",
    "",
    "【新日志】",
    formatEntries(entries),
    "",
    "要求：保留人名、关系、承诺、喜好、重要事件与关键数字；合并重复、删除琐碎内容。用中文输出一段不超过 300 字的摘要，只输出摘要正文，不要任何前缀或解释。"
  ].join("\n");
}

module.exports = {
  COMPRESS_THRESHOLD,
  KEEP_RECENT,
  MAX_RECENT,
  ENTRY_TEXT_LIMIT,
  SUMMARIZE_SYSTEM,
  COMPRESS_SYSTEM,
  createEntry,
  normalizeMemoryLog,
  emptyMemoryLog,
  appendEntry,
  shouldCompress,
  compressPlan,
  manualCompressPlan,
  applyCompression,
  formatEntries,
  buildMemoryContextPrompt,
  buildCompressPrompt
};
