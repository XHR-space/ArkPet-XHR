"use strict";

/*
 * Executable tests for the memory-log data layer.
 *
 * Run from the repository root:
 *   node electron/memory-log.test.cjs
 */

const assert = require("node:assert/strict");

const M = require("./memory-log.cjs");

let passed = 0;
let failed = 0;

/* ------------------------------------------------------------- harness */

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("ok   - " + name);
  } catch (error) {
    failed += 1;
    console.error("FAIL - " + name);
    console.error("       " + (error && error.message ? error.message : error));
  }
}

function buildLog(count, createdAtBase) {
  const recent = [];
  for (let index = 0; index < count; index += 1) {
    recent.push(
      M.createEntry(
        "dialogue",
        `日志第 ${index + 1} 条`,
        undefined,
        `${createdAtBase}T1${String(index).padStart(2, "0")}:00:00.000Z`
      )
    );
  }
  return { summary: "旧摘要", recent };
}

/* -------------------------------------------------------------- cases */

test("a) createEntry defaults kind to dialogue and truncates text", function () {
  const entry = M.createEntry("dialogue", "x".repeat(9000));
  assert.equal(entry.kind, "dialogue");
  assert.equal(entry.text.length, M.ENTRY_TEXT_LIMIT);
  assert.equal(typeof entry.id, "string");
  assert.equal(typeof entry.createdAt, "string");

  const behavior = M.createEntry("behavior", "被唤醒", "wake");
  assert.equal(behavior.kind, "behavior");
  assert.equal(behavior.source, "wake");

  const unknown = M.createEntry("noise", "内容");
  assert.equal(unknown.kind, "dialogue");
});

test("b) appendEntry appends and keeps summary; empty text entries are dropped", function () {
  const base = { summary: "摘要", recent: [] };
  const next = M.appendEntry(base, M.createEntry("dialogue", "你好"));
  assert.equal(next.recent.length, 1);
  assert.equal(next.summary, "摘要");
  assert.equal(next.recent[0].text, "你好");
  assert.equal(base.recent.length, 0, "input must not be mutated");
});

test("c) recent hits MAX_RECENT hard cap", function () {
  const memory = { summary: "", recent: [] };
  let next = memory;
  for (let index = 0; index < M.MAX_RECENT + 10; index += 1) {
    next = M.appendEntry(next, M.createEntry("dialogue", `第 ${index} 条`));
  }
  assert.equal(next.recent.length, M.MAX_RECENT);
  assert.equal(next.recent[0].text, "第 10 条", "oldest entries fall off the cap");
});

test("d) shouldCompress boundary is 50", function () {
  assert.equal(M.shouldCompress({ recent: buildLog(49).recent }), false);
  assert.equal(M.shouldCompress({ recent: buildLog(50).recent }), true);
  assert.equal(M.shouldCompress(null), false);
});

test("e) compressPlan: 50 entries remove the oldest 30 and keep 20", function () {
  const memory = buildLog(50);
  const plan = M.compressPlan(memory);
  assert.ok(plan, "plan must exist at threshold");
  assert.equal(plan.entries.length, 30);
  assert.equal(plan.removedIds.size, 30);
  assert.equal(plan.entries[0].text, "日志第 1 条");
  assert.equal(plan.entries[29].text, "日志第 30 条");

  const applied = M.applyCompression(memory, "新摘要", plan.removedIds);
  assert.equal(applied.summary, "新摘要");
  assert.equal(applied.recent.length, 20);
  assert.equal(applied.recent[0].text, "日志第 31 条");
});

test("f) compressPlan: 55 entries remove the oldest 35 and keep 20", function () {
  const memory = buildLog(55);
  const plan = M.compressPlan(memory);
  assert.equal(plan.entries.length, 35);
  const applied = M.applyCompression(memory, "新摘要", plan.removedIds);
  assert.equal(applied.recent.length, 20);
  assert.equal(applied.recent[0].text, "日志第 36 条");
});

test("g) compressPlan is null below threshold", function () {
  assert.equal(M.compressPlan(buildLog(49)), null);
});

test("h) applyCompression only removes planned ids (concurrent appends survive)", function () {
  const memory = buildLog(50);
  const plan = M.compressPlan(memory);
  // 压缩期间又有新对话写入。
  const withNew = M.appendEntry(memory, M.createEntry("dialogue", "并发新日志"));
  const applied = M.applyCompression(withNew, "新摘要", plan.removedIds);
  assert.equal(applied.recent.length, 21);
  assert.equal(applied.recent[20].text, "并发新日志");
});

test("i) manualCompressPlan takes every entry", function () {
  const memory = buildLog(7);
  const plan = M.manualCompressPlan(memory);
  assert.equal(plan.entries.length, 7);
  assert.equal(plan.removedIds.size, 7);
  const applied = M.applyCompression(memory, "全部摘要", plan.removedIds);
  assert.equal(applied.recent.length, 0);
  assert.equal(applied.summary, "全部摘要");
});

test("j) applyCompression keeps the old summary when the new one is empty", function () {
  const memory = buildLog(50);
  const plan = M.compressPlan(memory);
  const applied = M.applyCompression(memory, "   ", plan.removedIds);
  assert.equal(applied.summary, "旧摘要");
});

test("k) normalizeMemoryLog filters garbage and coerces kinds", function () {
  const normalized = M.normalizeMemoryLog({
    summary: 42,
    recent: [
      { id: "a", kind: "noise", text: "你好", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "b", text: "" },
      null,
      "字符串不是日志",
      { id: "c", kind: "module", text: "模组写入", source: 7 }
    ]
  });
  assert.equal(normalized.summary, "");
  assert.equal(normalized.recent.length, 2);
  assert.equal(normalized.recent[0].kind, "dialogue");
  assert.equal(normalized.recent[1].kind, "module");
  assert.equal(normalized.recent[1].source, "7");
});

test("l) buildMemoryContextPrompt contains summary, recent entries and user text", function () {
  const memory = {
    summary: "用户喜欢喝咖啡",
    recent: [M.createEntry("behavior", "用户双击了桌宠", "dblclick")]
  };
  const prompt = M.buildMemoryContextPrompt(memory, "今天想喝什么？");
  assert.ok(prompt.includes("用户喜欢喝咖啡"), "summary must be present");
  assert.ok(prompt.includes("用户双击了桌宠"), "entry must be present");
  assert.ok(prompt.includes("今天想喝什么？"), "user text must be present");
  assert.ok(prompt.includes("最多 5 条"), "instruction must be present");
});

test("m) buildCompressPrompt contains old summary and entries", function () {
  const prompt = M.buildCompressPrompt("旧摘要", [
    M.createEntry("dialogue", "一段对话")
  ]);
  assert.ok(prompt.includes("旧摘要"));
  assert.ok(prompt.includes("一段对话"));
  assert.ok(prompt.includes("300 字"));
});

test("n) formatEntries labels kinds and formats timestamps", function () {
  const text = M.formatEntries([
    M.createEntry("dialogue", "对话内容", undefined, "2026-11-18T08:30:00.000Z"),
    M.createEntry("behavior", "行为内容", "wake", "2026-11-18T08:31:00.000Z"),
    M.createEntry("module", "模组内容", undefined, "2026-11-18T08:32:00.000Z")
  ]);
  assert.ok(text.includes("[对话 2026-11-18 08:30:00] 对话内容"));
  assert.ok(text.includes("[行为 2026-11-18 08:31:00] 行为内容"));
  assert.ok(text.includes("[模组 2026-11-18 08:32:00] 模组内容"));
});

test("o) emptyMemoryLog returns a clean empty structure", function () {
  assert.deepEqual(M.emptyMemoryLog(), { summary: "", recent: [] });
});

/* ------------------------------------------------------------ summary */

console.log("");
console.log(passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
