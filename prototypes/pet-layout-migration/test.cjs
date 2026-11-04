"use strict";

/*
 * Fixture tests for the PetDesktopLayout v3 migration prototype.
 *
 * Run from the repository root:
 *   node prototypes/pet-layout-migration/test.cjs
 *
 * Every fixture also writes a human readable snapshot to ./snapshots so the
 * before/after geometry can be diffed in review without running the app.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const M = require("./migrate.cjs");

const SNAPSHOT_DIR = path.join(__dirname, "snapshots");
const TOLERANCE = 0.01;

let passed = 0;
let failed = 0;
const summaryRows = [];

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

function closeTo(actual, expected, tolerance, label) {
  const tol = tolerance === undefined ? TOLERANCE : tolerance;
  assert.equal(typeof actual, "number", label + ": expected a number, got " + actual);
  assert.ok(
    Math.abs(actual - expected) <= tol,
    label + ": expected " + expected + " +/- " + tol + ", got " + actual
  );
}

function writeSnapshot(name, data) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const file = path.join(SNAPSHOT_DIR, name + ".json");
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", {
    encoding: "utf8"
  });
  return path.relative(process.cwd(), file).split(path.sep).join("/");
}

/* Builds the snapshot payload: legacy inputs, migrated layout, resolved world
 * rectangles and invariant checks. */
function buildSnapshot(pet, result) {
  const legacyRect = M.resolveLegacyCollisionRect(pet);
  const legacyDisplayCenter = M.resolveLegacyDisplayFrameCenter(pet);
  const rects = M.resolveLayoutRects(result.layout);
  const direction = result.layout.placement.direction;
  const before = result.before || {};
  const rawOffsetX = Number.isFinite(before.droppedOffsetX) ? before.droppedOffsetX : 0;
  const rawOffsetY = Number.isFinite(before.droppedOffsetY) ? before.droppedOffsetY : 0;

  return {
    fixture: pet && pet.id ? pet.id : "(anonymous)",
    changed: result.changed,
    source: result.source,
    warnings: result.warnings,
    defaultsUsed: result.defaultsUsed,
    legacy: before,
    layout: result.layout,
    legacyWorld: {
      displayCenter: legacyDisplayCenter,
      collisionRect: legacyRect
    },
    migratedWorld: {
      displayCenter: rects.displayCenter,
      displayFrame: rects.displayFrame,
      collisionRect: rects.collision,
      interactionRect: rects.interaction
    },
    invariants: {
      collisionCenterPreserved:
        Math.abs(legacyRect.centerX - rects.collision.centerX) <= TOLERANCE &&
        Math.abs(legacyRect.centerY - rects.collision.centerY) <= TOLERANCE,
      displayCenterPreserved:
        Math.abs(legacyDisplayCenter.x - rects.displayCenter.x) <= TOLERANCE &&
        Math.abs(legacyDisplayCenter.y - rects.displayCenter.y) <= TOLERANCE,
      collisionSizePreserved:
        rects.collision.right - rects.collision.left === result.layout.collision.width &&
        rects.collision.bottom - rects.collision.top === result.layout.collision.height,
      interactionEqualsCollision:
        JSON.stringify(result.layout.interaction) === JSON.stringify(result.layout.collision)
    },
    /* The v3 runtime no longer applies the legacy sprite offset, so the sprite
     * snaps back to the display frame centre by exactly this amount. */
    droppedVisualOffset: {
      x: M.round2(direction * rawOffsetX),
      y: M.round2(rawOffsetY)
    }
  };
}

/* ------------------------------------------------------------ fixtures */

const FIXTURE_2_2_0 = {
  id: "fixture-a-arkpet-2.2.0",
  name: "黍-春日宴",
  renderConfig: {
    displayWidth: 300,
    displayHeight: 323,
    visualWidth: 128,
    visualHeight: 144,
    hitboxWidth: 96,
    hitboxHeight: 96,
    hitboxOffsetX: 20,
    hitboxOffsetY: 125,
    offsetX: 5,
    offsetY: 10
  },
  desktopRenderConfig: {
    displayWidth: 300,
    displayHeight: 323,
    visualWidth: 128,
    visualHeight: 144,
    hitboxWidth: 96,
    hitboxHeight: 96,
    hitboxOffsetX: 20,
    hitboxOffsetY: 125,
    offsetX: 5,
    offsetY: 10
  },
  desktopPosition: { x: 770, y: 971, direction: 1 }
};

const FIXTURE_V1_1 = {
  id: "fixture-b-v1.1",
  name: "legacy v1.1 pet",
  renderConfig: {
    displayWidth: 260,
    displayHeight: 320,
    visualWidth: 104,
    visualHeight: 134,
    hitboxWidth: 104,
    hitboxHeight: 134,
    hitboxOffsetX: 0,
    hitboxOffsetY: 0,
    offsetX: 0,
    offsetY: 0
  },
  desktopRenderConfig: {
    displayWidth: 260,
    displayHeight: 320,
    visualWidth: 104,
    visualHeight: 134,
    hitboxWidth: 104,
    hitboxHeight: 134,
    hitboxOffsetX: 0,
    hitboxOffsetY: 0,
    offsetX: 0,
    offsetY: 0
  },
  desktopPosition: { x: 300, y: 600 }
};

const FIXTURE_NO_RENDER_CONFIG = {
  id: "fixture-c-missing-render-config",
  name: "pet without render config",
  desktopPosition: { x: 100, y: 200, direction: -1 }
};

const FIXTURE_DIRECTION_LEFT = {
  id: "fixture-e-direction-left",
  name: "facing left",
  renderConfig: {
    displayWidth: 300,
    displayHeight: 323,
    visualWidth: 128,
    visualHeight: 144,
    hitboxWidth: 96,
    hitboxHeight: 96,
    hitboxOffsetX: 20,
    hitboxOffsetY: 125,
    offsetX: 5,
    offsetY: 10
  },
  desktopRenderConfig: {
    displayWidth: 300,
    displayHeight: 323,
    visualWidth: 128,
    visualHeight: 144,
    hitboxWidth: 96,
    hitboxHeight: 96,
    hitboxOffsetX: 20,
    hitboxOffsetY: 125,
    offsetX: 5,
    offsetY: 10
  },
  desktopPosition: { x: 770, y: 971, direction: -1 }
};

const FIXTURE_ROUNDING = {
  id: "fixture-g-rounding",
  name: "decimal noise",
  renderConfig: {
    displayWidth: 300,
    displayHeight: 323,
    visualWidth: 127,
    visualHeight: 144,
    hitboxWidth: 97,
    hitboxHeight: 97,
    hitboxOffsetX: 20.125,
    hitboxOffsetY: 125.125,
    offsetX: 0,
    offsetY: 0
  },
  desktopPosition: { x: 770, y: 971, direction: 1 }
};

/* ---------------------------------------------------------------- a) 2.2 */

test("a) ArkPet 2.2.0 typical config migrates to v3", function () {
  const result = M.migratePetLayout(FIXTURE_2_2_0);
  assert.equal(result.changed, true);
  assert.equal(result.layout.layoutVersion, 3);
  assert.equal(result.warnings.length, 0);

  /* displayFrame = max(display, visual) per axis. */
  assert.deepEqual(result.layout.displayFrame, { width: 300, height: 323 });

  /* centerX = 96/2 = 48 ; centerY = 96 - 323/2 = -65.5
   * collision centre = (20 + 48, 125 + 48) = (68, 173)
   * collision.offset  = (68 - 48, 173 - (-65.5)) = (20, 238.5) */
  closeTo(result.layout.collision.width, 96, TOLERANCE, "collision.width");
  closeTo(result.layout.collision.height, 96, TOLERANCE, "collision.height");
  /* host basis: the body sits at the bottom centre of the display frame, so
   * offsetX is 0 and offsetY = 323/2 - 96/2 = 113.5. */
  closeTo(result.layout.collision.offsetX, 0, TOLERANCE, "collision.offsetX");
  closeTo(result.layout.collision.offsetY, 113.5, TOLERANCE, "collision.offsetY");

  /* interaction copies collision exactly. */
  assert.deepEqual(result.layout.interaction, result.layout.collision);

  /* placement = old host top-left + collision centre. */
  /* placement is the host (physics) centre: 770 + 48 = 818, 971 + 48 = 1019. */
  closeTo(result.layout.placement.x, 818, TOLERANCE, "placement.x");
  closeTo(result.layout.placement.y, 1019, TOLERANCE, "placement.y");
  assert.equal(result.layout.placement.direction, 1);

  /* Invariant: the world rectangle of the collision body must not move. */
  const legacyRect = M.resolveLegacyCollisionRect(FIXTURE_2_2_0);
  const rects = M.resolveLayoutRects(result.layout);
  closeTo(rects.collision.centerX, legacyRect.centerX, TOLERANCE, "collision world centre X");
  closeTo(rects.collision.centerY, legacyRect.centerY, TOLERANCE, "collision world centre Y");
  closeTo(rects.collision.left, legacyRect.left, TOLERANCE, "collision world left");
  closeTo(rects.collision.top, legacyRect.top, TOLERANCE, "collision world top");

  /* The display frame centre is direction invariant and must not move either. */
  const legacyDisplayCenter = M.resolveLegacyDisplayFrameCenter(FIXTURE_2_2_0);
  closeTo(legacyDisplayCenter.x, 818, TOLERANCE, "legacy display centre X");
  closeTo(legacyDisplayCenter.y, 905.5, TOLERANCE, "legacy display centre Y");
  closeTo(rects.displayCenter.x, legacyDisplayCenter.x, TOLERANCE, "display centre X");
  closeTo(rects.displayCenter.y, legacyDisplayCenter.y, TOLERANCE, "display centre Y");

  /* Rule 6: the legacy sprite offset is dropped, not migrated. */
  assert.equal(result.before.droppedOffsetX, 5);
  assert.equal(result.before.droppedOffsetY, 10);

  const file = writeSnapshot("01-arkpet-2.2.0", buildSnapshot(FIXTURE_2_2_0, result));
  console.log("       snapshot: " + file);
  summaryRows.push({
    fixture: "a) 2.2.0",
    beforeCollision: legacyRect,
    afterCollision: rects.collision,
    placement: result.layout.placement
  });
});

/* --------------------------------------------------------------- b) 1.1 */

test("b) v1.1 style config migrates to v3", function () {
  const result = M.migratePetLayout(FIXTURE_V1_1);
  assert.equal(result.changed, true);
  assert.equal(result.warnings.length, 0);

  /* centerX = 104/2 = 52 ; centerY = 134 - 320/2 = -26
   * collision centre = (52, 67) ; offset = (0, 93) */
  assert.deepEqual(result.layout.displayFrame, { width: 260, height: 320 });
  closeTo(result.layout.collision.width, 104, TOLERANCE, "collision.width");
  closeTo(result.layout.collision.height, 134, TOLERANCE, "collision.height");
  closeTo(result.layout.collision.offsetX, 0, TOLERANCE, "collision.offsetX");
  closeTo(result.layout.collision.offsetY, 93, TOLERANCE, "collision.offsetY");
  closeTo(result.layout.placement.x, 352, TOLERANCE, "placement.x");
  closeTo(result.layout.placement.y, 667, TOLERANCE, "placement.y");
  assert.equal(result.layout.placement.direction, 1, "missing direction defaults to 1");
  assert.deepEqual(result.layout.interaction, result.layout.collision);

  const legacyRect = M.resolveLegacyCollisionRect(FIXTURE_V1_1);
  const rects = M.resolveLayoutRects(result.layout);
  closeTo(rects.collision.centerX, legacyRect.centerX, TOLERANCE, "collision world centre X");
  closeTo(rects.collision.centerY, legacyRect.centerY, TOLERANCE, "collision world centre Y");

  const legacyDisplayCenter = M.resolveLegacyDisplayFrameCenter(FIXTURE_V1_1);
  closeTo(legacyDisplayCenter.x, 352, TOLERANCE, "legacy display centre X");
  closeTo(legacyDisplayCenter.y, 574, TOLERANCE, "legacy display centre Y");
  closeTo(rects.displayCenter.x, legacyDisplayCenter.x, TOLERANCE, "display centre X");
  closeTo(rects.displayCenter.y, legacyDisplayCenter.y, TOLERANCE, "display centre Y");

  const file = writeSnapshot("02-v1.1", buildSnapshot(FIXTURE_V1_1, result));
  console.log("       snapshot: " + file);
  summaryRows.push({
    fixture: "b) v1.1",
    beforeCollision: legacyRect,
    afterCollision: rects.collision,
    placement: result.layout.placement
  });
});

/* --------------------------------------------------- c) no renderConfig */

test("c) pet without renderConfig falls back to defaults and warns", function () {
  const result = M.migratePetLayout(FIXTURE_NO_RENDER_CONFIG);
  assert.equal(result.changed, true);
  assert.ok(result.warnings.includes("missing-render-config"), "expected missing-render-config warning");
  assert.equal(result.source, "defaults");

  /* Defaults: display 260x320, visual 104x134, hitbox 104x134, offsets 0/0. */
  assert.deepEqual(result.layout.displayFrame, { width: 260, height: 320 });
  closeTo(result.layout.collision.width, 104, TOLERANCE, "collision.width");
  closeTo(result.layout.collision.height, 134, TOLERANCE, "collision.height");
  closeTo(result.layout.collision.offsetX, 0, TOLERANCE, "collision.offsetX");
  closeTo(result.layout.collision.offsetY, 93, TOLERANCE, "collision.offsetY");
  closeTo(result.layout.placement.x, 152, TOLERANCE, "placement.x");
  closeTo(result.layout.placement.y, 267, TOLERANCE, "placement.y");

  /* The stored direction must still be honoured. */
  assert.equal(result.layout.placement.direction, -1);

  const legacyRect = M.resolveLegacyCollisionRect(FIXTURE_NO_RENDER_CONFIG);
  const rects = M.resolveLayoutRects(result.layout);
  closeTo(rects.collision.centerX, legacyRect.centerX, TOLERANCE, "collision world centre X");
  closeTo(rects.collision.centerY, legacyRect.centerY, TOLERANCE, "collision world centre Y");

  const file = writeSnapshot("03-missing-render-config", buildSnapshot(FIXTURE_NO_RENDER_CONFIG, result));
  console.log("       snapshot: " + file);
  summaryRows.push({
    fixture: "c) no renderConfig",
    beforeCollision: legacyRect,
    afterCollision: rects.collision,
    placement: result.layout.placement
  });
});

/* ------------------------------------------------------------- d) v3 x3 */

test("d) an already-v3 record is idempotent and ignores legacy fields", function () {
  const first = M.migratePetLayout(FIXTURE_2_2_0);
  const v3Pet = { id: FIXTURE_2_2_0.id, layout: first.layout };

  const second = M.migratePetLayout(v3Pet);
  const third = M.migratePetLayout(v3Pet);

  assert.equal(second.changed, false, "second run must not report a change");
  assert.equal(third.changed, false, "third run must not report a change");
  assert.deepEqual(second.layout, first.layout, "second run must return the same layout");
  assert.deepEqual(third.layout, first.layout, "third run must return the same layout");
  assert.deepEqual(second.warnings, []);

  /* Even a corrupted legacy tail must not shift an existing v3 layout. */
  const corrupted = {
    id: FIXTURE_2_2_0.id,
    layout: first.layout,
    renderConfig: { hitboxWidth: 999, hitboxHeight: 999, hitboxOffsetX: -400 },
    desktopPosition: { x: -5000, y: -5000, direction: -1 }
  };
  const fromCorrupted = M.migratePetLayout(corrupted);
  assert.equal(fromCorrupted.changed, false);
  assert.deepEqual(fromCorrupted.layout, first.layout);

  const file = writeSnapshot("04-v3-idempotent", {
    fixture: FIXTURE_2_2_0.id,
    run1: first.layout,
    run2: second.layout,
    run3: third.layout,
    identical:
      JSON.stringify(second.layout) === JSON.stringify(first.layout) &&
      JSON.stringify(third.layout) === JSON.stringify(first.layout),
    corruptedLegacyIgnored:
      JSON.stringify(fromCorrupted.layout) === JSON.stringify(first.layout)
  });
  console.log("       snapshot: " + file);
});

/* -------------------------------------------------------- e) direction */

test("e) direction=-1 is preserved and only mirrored at resolve time", function () {
  const result = M.migratePetLayout(FIXTURE_DIRECTION_LEFT);
  assert.equal(result.layout.placement.direction, -1);

  /* The host basis is direction invariant, exactly like the legacy host. */
  closeTo(result.layout.collision.offsetX, 0, TOLERANCE, "stored collision.offsetX");
  assert.equal(M.mirrorOffsetX(result.layout.collision.offsetX, -1), 0);

  closeTo(result.layout.placement.x, 818, TOLERANCE, "placement.x");
  closeTo(result.layout.placement.y, 1019, TOLERANCE, "placement.y");
  assert.equal(result.placementFormula, "host-collision-center");

  const legacyRect = M.resolveLegacyCollisionRect(FIXTURE_DIRECTION_LEFT);
  const legacyDisplayCenter = M.resolveLegacyDisplayFrameCenter(FIXTURE_DIRECTION_LEFT);
  const rects = M.resolveLayoutRects(result.layout);
  closeTo(rects.collision.centerX, legacyRect.centerX, TOLERANCE, "collision world centre X");
  closeTo(rects.collision.centerY, legacyRect.centerY, TOLERANCE, "collision world centre Y");
  closeTo(rects.collision.left, legacyRect.left, TOLERANCE, "collision world left");
  closeTo(rects.displayCenter.x, 818, TOLERANCE, "display frame centre X");
  closeTo(rects.displayCenter.y, 905.5, TOLERANCE, "display frame centre Y");
  closeTo(rects.displayCenter.x, legacyDisplayCenter.x, TOLERANCE, "legacy display centre X");
  closeTo(rects.displayCenter.y, legacyDisplayCenter.y, TOLERANCE, "legacy display centre Y");

  /* The legacy-offset reading adds hitboxOffsetX/Y to the body centre, which in
   * 2.2.0 only ever moved the pointer target. Recording it shows the pet would
   *   jump by exactly that offset, so the host basis is the one we ship. */
  const editorOffset = M.migratePetLayoutWithOptions(FIXTURE_DIRECTION_LEFT, {
    geometryBasis: "editor-offset"
  });
  assert.equal(editorOffset.placementFormula, "editor-offset-center");
  const offsetShiftX = M.round2(editorOffset.layout.placement.x - result.layout.placement.x);
  const offsetShiftY = M.round2(editorOffset.layout.placement.y - result.layout.placement.y);
  closeTo(offsetShiftX, -FIXTURE_DIRECTION_LEFT.renderConfig.hitboxOffsetX, TOLERANCE, "editor-offset shift X");
  const expectedShiftY =
    FIXTURE_DIRECTION_LEFT.renderConfig.hitboxOffsetY -
    (Math.max(FIXTURE_DIRECTION_LEFT.renderConfig.displayHeight, FIXTURE_DIRECTION_LEFT.renderConfig.visualHeight) -
      FIXTURE_DIRECTION_LEFT.renderConfig.hitboxHeight) / 2;
  closeTo(offsetShiftY, expectedShiftY, TOLERANCE, "editor-offset shift Y");

  const snapshot = buildSnapshot(FIXTURE_DIRECTION_LEFT, result);
  snapshot.geometryBasisComparison = {
    note: "editor-offset 口径会把新碰撞体放到旧编辑器框的位量，角色会按差值下落/上移",
    editorOffsetPlacement: editorOffset.layout.placement,
    usedPlacement: result.layout.placement,
    shiftPx: { x: offsetShiftX, y: offsetShiftY }
  };

  const file = writeSnapshot("05-direction-left", snapshot);
  console.log("       snapshot: " + file);
});

/* ------------------------------------------------- f) repeat / purity */

test("f) repeated import of the same backup is deterministic and non-mutating", function () {
  const sample = JSON.parse(JSON.stringify(FIXTURE_2_2_0));
  const frozen = JSON.stringify(sample);

  const runs = [0, 1, 2].map(function () {
    return M.migratePetLayout(sample);
  });

  const serialized = runs.map(function (run) {
    return JSON.stringify(run.layout);
  });
  assert.equal(serialized[0], serialized[1], "run 1 and 2 must match");
  assert.equal(serialized[1], serialized[2], "run 2 and 3 must match");

  assert.equal(JSON.stringify(sample), frozen, "input record must not be mutated");
  assert.equal(runs[0].changed && runs[1].changed && runs[2].changed, true);

  /* A v3 record stays stable across repeated imports too. */
  const v3Pet = { id: sample.id, layout: runs[0].layout };
  const again = [0, 1].map(function () {
    return JSON.stringify(M.migratePetLayout(v3Pet).layout);
  });
  assert.equal(again[0], again[1], "v3 layout must be stable across imports");

  const file = writeSnapshot("06-repeat-determinism", {
    fixture: sample.id,
    runs: runs.map(function (run) {
      return run.layout;
    }),
    identical: serialized[0] === serialized[1] && serialized[1] === serialized[2],
    inputUnchanged: JSON.stringify(sample) === frozen
  });
  console.log("       snapshot: " + file);
});

/* ---------------------------------------------------------- g) rounding */

test("g) rounding is capped at 2 decimals and symmetric around zero", function () {
  assert.equal(M.round2(238.125), 238.13);
  assert.equal(M.round2(838.625), 838.63);
  assert.equal(M.round2(-238.125), -238.13);
  assert.equal(M.round2(-0.001), 0);
  assert.ok(!Object.is(M.round2(-0.001), -0), "must normalise negative zero");

  const result = M.migratePetLayout(FIXTURE_ROUNDING);
  const values = [
    result.layout.displayFrame.width,
    result.layout.displayFrame.height,
    result.layout.collision.width,
    result.layout.collision.height,
    result.layout.collision.offsetX,
    result.layout.collision.offsetY,
    result.layout.placement.x,
    result.layout.placement.y
  ];
  values.forEach(function (value) {
    assert.equal(Math.round(value * 100) / 100, value, "value must have <= 2 decimals: " + value);
  });

  /* host basis: offsetX = 0 ; offsetY = 323/2 - 97/2 = 113 */
  closeTo(result.layout.collision.offsetX, 0, TOLERANCE, "rounded collision.offsetX");
  closeTo(result.layout.collision.offsetY, 113, TOLERANCE, "rounded collision.offsetY");
  /* half-pixel placement still has to survive the rounding */
  closeTo(result.layout.placement.x, 818.5, TOLERANCE, "rounded placement.x");

  const file = writeSnapshot("07-rounding", buildSnapshot(FIXTURE_ROUNDING, result));
  console.log("       snapshot: " + file);
});

/* ------------------------------------------------------------ summary */

console.log("");
console.log("before/after collision world geometry (tolerance " + TOLERANCE + "):");
summaryRows.forEach(function (row) {
  const before = row.beforeCollision;
  const after = row.afterCollision;
  console.log(
    "  " + row.fixture.padEnd(18) +
      " before centre (" + before.centerX + ", " + before.centerY + ")" +
      " -> after centre (" + after.centerX + ", " + after.centerY + ")"
  );
  console.log(
    "  " + "".padEnd(18) +
      " placement (" + row.placement.x + ", " + row.placement.y + ")" +
      " direction " + row.placement.direction
  );
});

console.log("");
console.log(passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
