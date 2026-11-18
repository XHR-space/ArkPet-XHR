"use strict";

/*
 * Executable tests for the PetDesktopLayout v3 data layer.
 *
 * Run from the repository root:
 *   node electron/pet-layout.test.cjs
 *
 * Covers the seven fixtures from prototypes/pet-layout-migration/test.cjs as
 * equivalent scenarios, plus the store.cjs integration points: incremental
 * layout write on load, idempotent reload, and pets that only exist in the
 * pet-store sidecar.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const M = require("./pet-layout.cjs");
const { Store, STATE_FILE, createDefaultState } = require("./store.cjs");

const TOLERANCE = 0.01;

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

function closeTo(actual, expected, tolerance, label) {
  const tol = tolerance === undefined ? TOLERANCE : tolerance;
  assert.equal(typeof actual, "number", label + ": expected a number, got " + actual);
  assert.ok(
    Math.abs(actual - expected) <= tol,
    label + ": expected " + expected + " +/- " + tol + ", got " + actual
  );
}

function withTempStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pet-layout-test-"));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeState(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2), "utf8");
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

  // displayFrame 偏移与碰撞框偏移互为相反数：offsetY = 96/2 - 323/2 = -113.5
  assert.deepEqual(result.layout.displayFrame, {
    width: 300,
    height: 323,
    offsetX: 0,
    offsetY: -113.5
  });

  closeTo(result.layout.collision.width, 96, TOLERANCE, "collision.width");
  closeTo(result.layout.collision.height, 96, TOLERANCE, "collision.height");
  /* host basis: offsetX = 0 ; offsetY = 323/2 - 96/2 = 113.5 */
  closeTo(result.layout.collision.offsetX, 0, TOLERANCE, "collision.offsetX");
  closeTo(result.layout.collision.offsetY, 113.5, TOLERANCE, "collision.offsetY");

  assert.deepEqual(result.layout.interaction, result.layout.collision);

  /* placement is the host (physics) centre: 770 + 48 = 818, 971 + 48 = 1019. */
  closeTo(result.layout.placement.x, 818, TOLERANCE, "placement.x");
  closeTo(result.layout.placement.y, 1019, TOLERANCE, "placement.y");
  assert.equal(result.layout.placement.direction, 1);

  const legacyRect = M.resolveLegacyCollisionRect(FIXTURE_2_2_0);
  const rects = M.resolveLayoutRects(result.layout);
  closeTo(rects.collision.centerX, legacyRect.centerX, TOLERANCE, "collision world centre X");
  closeTo(rects.collision.centerY, legacyRect.centerY, TOLERANCE, "collision world centre Y");
  closeTo(rects.collision.left, legacyRect.left, TOLERANCE, "collision world left");
  closeTo(rects.collision.top, legacyRect.top, TOLERANCE, "collision world top");

  const legacyDisplayCenter = M.resolveLegacyDisplayFrameCenter(FIXTURE_2_2_0);
  closeTo(legacyDisplayCenter.x, 818, TOLERANCE, "legacy display centre X");
  closeTo(legacyDisplayCenter.y, 905.5, TOLERANCE, "legacy display centre Y");
  closeTo(rects.displayCenter.x, legacyDisplayCenter.x, TOLERANCE, "display centre X");
  closeTo(rects.displayCenter.y, legacyDisplayCenter.y, TOLERANCE, "display centre Y");

  assert.equal(result.before.droppedOffsetX, 5);
  assert.equal(result.before.droppedOffsetY, 10);
});

/* --------------------------------------------------------------- b) 1.1 */

test("b) v1.1 style config migrates to v3", function () {
  const result = M.migratePetLayout(FIXTURE_V1_1);
  assert.equal(result.changed, true);
  assert.equal(result.warnings.length, 0);

  // displayFrame 偏移与碰撞框偏移互为相反数：offsetY = 134/2 - 320/2 = -93
  assert.deepEqual(result.layout.displayFrame, {
    width: 260,
    height: 320,
    offsetX: 0,
    offsetY: -93
  });
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
});

/* --------------------------------------------------- c) no renderConfig */

test("c) pet without renderConfig falls back to defaults and warns", function () {
  const result = M.migratePetLayout(FIXTURE_NO_RENDER_CONFIG);
  assert.equal(result.changed, true);
  assert.ok(result.warnings.includes("missing-render-config"), "expected missing-render-config warning");
  assert.equal(result.source, "defaults");

  // displayFrame 偏移与碰撞框偏移互为相反数：offsetY = 134/2 - 320/2 = -93
  assert.deepEqual(result.layout.displayFrame, {
    width: 260,
    height: 320,
    offsetX: 0,
    offsetY: -93
  });
  closeTo(result.layout.collision.width, 104, TOLERANCE, "collision.width");
  closeTo(result.layout.collision.height, 134, TOLERANCE, "collision.height");
  closeTo(result.layout.collision.offsetX, 0, TOLERANCE, "collision.offsetX");
  closeTo(result.layout.collision.offsetY, 93, TOLERANCE, "collision.offsetY");
  closeTo(result.layout.placement.x, 152, TOLERANCE, "placement.x");
  closeTo(result.layout.placement.y, 267, TOLERANCE, "placement.y");
  assert.equal(result.layout.placement.direction, -1);

  const legacyRect = M.resolveLegacyCollisionRect(FIXTURE_NO_RENDER_CONFIG);
  const rects = M.resolveLayoutRects(result.layout);
  closeTo(rects.collision.centerX, legacyRect.centerX, TOLERANCE, "collision world centre X");
  closeTo(rects.collision.centerY, legacyRect.centerY, TOLERANCE, "collision world centre Y");
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

  const corrupted = {
    id: FIXTURE_2_2_0.id,
    layout: first.layout,
    renderConfig: { hitboxWidth: 999, hitboxHeight: 999, hitboxOffsetX: -400 },
    desktopPosition: { x: -5000, y: -5000, direction: -1 }
  };
  const fromCorrupted = M.migratePetLayout(corrupted);
  assert.equal(fromCorrupted.changed, false);
  assert.deepEqual(fromCorrupted.layout, first.layout);
});

/* -------------------------------------------------------- e) direction */

test("e) direction=-1 is preserved and only mirrored at resolve time", function () {
  const result = M.migratePetLayout(FIXTURE_DIRECTION_LEFT);
  assert.equal(result.layout.placement.direction, -1);

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

  /* The legacy-offset basis is shipped only for A/B review; it moves the body
   * by hitboxOffsetX/Y, which 2.2.0 never did. */
  const legacyOffset = M.migratePetLayoutWithOptions(FIXTURE_DIRECTION_LEFT, {
    geometryBasis: "legacy-offset"
  });
  assert.equal(legacyOffset.placementFormula, "legacy-offset-center");
  const offsetShiftX = M.round2(legacyOffset.layout.placement.x - result.layout.placement.x);
  const offsetShiftY = M.round2(legacyOffset.layout.placement.y - result.layout.placement.y);
  closeTo(offsetShiftX, -FIXTURE_DIRECTION_LEFT.renderConfig.hitboxOffsetX, TOLERANCE, "legacy-offset shift X");
  closeTo(offsetShiftY, FIXTURE_DIRECTION_LEFT.renderConfig.hitboxOffsetY, TOLERANCE, "legacy-offset shift Y");
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

  const v3Pet = { id: sample.id, layout: runs[0].layout };
  const again = [0, 1].map(function () {
    return JSON.stringify(M.migratePetLayout(v3Pet).layout);
  });
  assert.equal(again[0], again[1], "v3 layout must be stable across imports");
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

  closeTo(result.layout.collision.offsetX, 0, TOLERANCE, "rounded collision.offsetX");
  closeTo(result.layout.collision.offsetY, 113, TOLERANCE, "rounded collision.offsetY");
  closeTo(result.layout.placement.x, 818.5, TOLERANCE, "rounded placement.x");
});

/* ------------------------------------------------ h) store: incremental */

test("h) store.load() adds a v3 layout and keeps every legacy field", function () {
  withTempStore(function (dir) {
    const seed = createDefaultState();
    const legacyPet = JSON.parse(JSON.stringify(FIXTURE_2_2_0));
    seed.pets = [legacyPet];
    seed.activePetId = legacyPet.id;
    seed.summonedPetIds = [legacyPet.id];
    writeState(dir, seed);

    const store = new Store(dir);
    const loaded = store.load();
    const pet = loaded.pets.find((item) => item.id === legacyPet.id);

    assert.ok(pet, "pet must survive load");
    assert.ok(pet.layout && pet.layout.layoutVersion === 3, "layout v3 must be present");

    /* Incremental write: the old geometry fields are untouched so rollback is
     * possible and the migration can be diffed against the source of truth. */
    assert.deepEqual(pet.renderConfig, FIXTURE_2_2_0.renderConfig, "renderConfig preserved");
    assert.deepEqual(
      pet.desktopRenderConfig,
      FIXTURE_2_2_0.desktopRenderConfig,
      "desktopRenderConfig preserved"
    );
    assert.deepEqual(pet.desktopPosition, FIXTURE_2_2_0.desktopPosition, "desktopPosition preserved");

    closeTo(pet.layout.placement.x, 818, TOLERANCE, "store placement.x");
    closeTo(pet.layout.placement.y, 1019, TOLERANCE, "store placement.y");
    assert.equal(pet.layout.placement.direction, 1);
  });
});

/* ------------------------------------------------- i) store: idempotent */

test("i) store.load() twice does not recompute or move an existing v3 layout", function () {
  withTempStore(function (dir) {
    const seed = createDefaultState();
    const legacyPet = JSON.parse(JSON.stringify(FIXTURE_2_2_0));
    seed.pets = [legacyPet];
    seed.activePetId = legacyPet.id;
    seed.summonedPetIds = [legacyPet.id];
    writeState(dir, seed);

    const first = new Store(dir).load().pets.find((item) => item.id === legacyPet.id);
    assert.ok(first.layout, "first load must create the layout");

    /* Second load reads the persisted v3 record. Even if the legacy fields were
     * corrupted in between, the layout must be returned verbatim. */
    const persisted = JSON.parse(
      fs.readFileSync(path.join(dir, STATE_FILE), "utf8")
    );
    const persistedPet = persisted.pets.find((item) => item.id === legacyPet.id);
    persistedPet.renderConfig = { hitboxWidth: 999, hitboxHeight: 999, hitboxOffsetX: -400 };
    persistedPet.desktopPosition = { x: -5000, y: -5000, direction: -1 };
    writeState(dir, persisted);

    const second = new Store(dir).load().pets.find((item) => item.id === legacyPet.id);
    assert.deepEqual(second.layout, first.layout, "layout must be byte-identical on reload");
    closeTo(second.layout.placement.x, 818, TOLERANCE, "placement.x unchanged");
    closeTo(second.layout.placement.y, 1019, TOLERANCE, "placement.y unchanged");
  });
});

/* --------------------------------------------- j) store: pet-store sidecar */

test("j) a pet that only exists in the pet-store also receives a layout", function () {
  withTempStore(function (dir) {
    const seed = createDefaultState();
    writeState(dir, seed);

    const sidecarPet = JSON.parse(JSON.stringify(FIXTURE_V1_1));
    const petStoreDir = path.join(dir, "pet-store");
    fs.mkdirSync(petStoreDir, { recursive: true });
    fs.writeFileSync(
      path.join(petStoreDir, sidecarPet.id + ".json"),
      JSON.stringify(sidecarPet, null, 2),
      "utf8"
    );

    const loaded = new Store(dir).load();
    const pet = loaded.pets.find((item) => item.id === sidecarPet.id);
    assert.ok(pet, "pet-store pet must be merged into state");
    assert.ok(pet.layout && pet.layout.layoutVersion === 3, "pet-store pet must get a layout");
    closeTo(pet.layout.placement.x, 352, TOLERANCE, "pet-store placement.x");
    closeTo(pet.layout.placement.y, 667, TOLERANCE, "pet-store placement.y");
  });
});

test("k) per-pet windows remain opt-in by default", function () {
  assert.equal(createDefaultState().settings.overlay.perPetWindows, false);
});

test("l) layout patch merge keeps unknown fields, forces v3 and does not mutate input", function () {
  const current = {
    layoutVersion: 3,
    displayFrame: { width: 260, height: 320 },
    collision: { width: 104, height: 134, offsetX: 0, offsetY: 93 },
    interaction: { width: 104, height: 134, offsetX: 0, offsetY: 93 },
    placement: { x: 352, y: 667, direction: 1 },
    extraFutureField: { keep: true }
  };
  const merged = M.mergeLayoutPatch(current, {
    placement: { x: 500.25, y: 600, direction: -1 },
    collision: { offsetX: 12 }
  });
  assert.equal(merged.layoutVersion, 3);
  assert.deepEqual(merged.extraFutureField, { keep: true });
  assert.deepEqual(merged.collision, { width: 104, height: 134, offsetX: 12, offsetY: 93 });
  assert.deepEqual(merged.placement, { x: 500.25, y: 600, direction: -1 });
  assert.deepEqual(current.placement, { x: 352, y: 667, direction: 1 }, "must not mutate the input");
  assert.equal(M.mergeLayoutPatch(null, null), null);
});

test("m) explicit displayFrame.offset moves the display centre (mirrored X)", function () {
  const layout = {
    layoutVersion: 3,
    displayFrame: { width: 260, height: 320, offsetX: 40, offsetY: -30 },
    collision: { width: 104, height: 134, offsetX: -40, offsetY: 30 },
    interaction: { width: 104, height: 134, offsetX: 0, offsetY: 0 },
    placement: { x: 352, y: 667, direction: -1 }
  };
  const rects = M.resolveLayoutRects(layout);
  closeTo(rects.displayCenter.x, 312, TOLERANCE, "display centre X (mirrored 40)");
  closeTo(rects.displayCenter.y, 637, TOLERANCE, "display centre Y");
  // 碰撞框中心仍等于 placement。
  closeTo(rects.collision.centerX, 352, TOLERANCE, "collision centre X");
  closeTo(rects.collision.centerY, 667, TOLERANCE, "collision centre Y");
});

test("n) legacy v3 records without displayFrame.offset fall back to -collision", function () {
  const layout = {
    layoutVersion: 3,
    displayFrame: { width: 260, height: 320 },
    collision: { width: 104, height: 134, offsetX: 0, offsetY: 93 },
    interaction: { width: 104, height: 134, offsetX: 0, offsetY: 93 },
    placement: { x: 352, y: 667, direction: 1 }
  };
  const rects = M.resolveLayoutRects(layout);
  closeTo(rects.displayCenter.x, 352, TOLERANCE, "display centre X");
  closeTo(rects.displayCenter.y, 574, TOLERANCE, "display centre Y");
});
/* ------------------------------------------------------------ summary */

console.log("");
console.log(passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
