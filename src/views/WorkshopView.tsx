import { Color, SkeletonBinary } from "@pixi-spine/all-3.8";
import {
  AudioLines,
  Bot,
  CheckCircle2,
  File,
  Image as ImageIcon,
  Layers3,
  Plus,
  Puzzle,
  Save,
  ScanLine,
  SlidersHorizontal,
  Trash2,
  Upload,
  Volume2,
  X
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PetAvatar } from "../components/PetAvatar";
import { SpinePet } from "../components/SpinePet";
import { makeId, makeUniqueName } from "../lib/id";
import {
  chooseBoundAnimation,
  universalActions,
  validateActionSet,
  type ActionDiagnostics
} from "../lib/spineActions";
import {
  FIRST_PET_LEG_WALK,
  FIRST_PET_LEG_WALK_LABEL
} from "../lib/firstPetLegWalk";
import {
  getHitboxPosition,
  withRenderConfigDefaults
} from "../lib/renderConfig";
import { useAppState } from "../state";
import type {
  BoneRoleMap,
  PetModulePlugins,
  PetProfile,
  PetRenderConfig,
  PetVoiceClip,
  PetVoiceLines,
  SpinePartKind,
  SpineStagedPart
} from "../types";

type WorkshopMode = "edit" | "create";
type AdvancedResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const advancedResizeEdges: AdvancedResizeEdge[] = [
  "n",
  "s",
  "e",
  "w",
  "ne",
  "nw",
  "se",
  "sw"
];

function hasSameRenderConfig(
  left: Partial<PetRenderConfig> | null,
  right: Partial<PetRenderConfig> | null
) {
  return (
    JSON.stringify(withRenderConfigDefaults(left)) ===
    JSON.stringify(withRenderConfigDefaults(right))
  );
}

export const ADVANCED_DRAFT_STORAGE_PREFIX =
  "arkpet:advanced-render-draft:v1:";

function getAdvancedDraftStorageKey(petId: string) {
  return `${ADVANCED_DRAFT_STORAGE_PREFIX}${petId}`;
}

function readAdvancedRenderDraft(petId: string): PetRenderConfig | null {
  try {
    const raw = window.sessionStorage.getItem(getAdvancedDraftStorageKey(petId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PetRenderConfig> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return withRenderConfigDefaults(parsed);
  } catch {
    return null;
  }
}

function writeAdvancedRenderDraft(petId: string, draft: PetRenderConfig) {
  try {
    window.sessionStorage.setItem(
      getAdvancedDraftStorageKey(petId),
      JSON.stringify(withRenderConfigDefaults(draft))
    );
  } catch {
    // Session storage can be unavailable in restricted renderer contexts.
  }
}

function clearAdvancedRenderDraft(petId: string) {
  try {
    window.sessionStorage.removeItem(getAdvancedDraftStorageKey(petId));
  } catch {
    // Nothing to clear when session storage is unavailable.
  }
}

function formatVoiceInterval(seconds: number) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

const spineSlots: Array<{
  kind: SpinePartKind;
  label: string;
  hint: string;
  icon: typeof File;
}> = [
  { kind: "skeleton", label: "骨骼文件", hint: ".skel", icon: File },
  { kind: "atlas", label: "图集文件", hint: ".atlas", icon: Layers3 },
  { kind: "texture", label: "纹理页", hint: "PNG", icon: ImageIcon }
];

export function WorkshopView() {
  const { state, updateState, refresh } = useAppState();
  const [mode, setMode] = useState<WorkshopMode>("edit");
  const [draftId, setDraftId] = useState(() => makeId("spine-draft"));
  const [petNameError, setPetNameError] = useState("");
  const [draftParts, setDraftParts] = useState<
    Partial<Record<SpinePartKind, SpineStagedPart>>
  >({});
  const [creating, setCreating] = useState(false);
  const [previewAction, setPreviewAction] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advancedMode, setAdvancedMode] = useState<
    "position" | "hitbox" | "display"
  >("hitbox");
  const [draftRenderConfig, setDraftRenderConfig] =
    useState<PetRenderConfig | null>(null);
  const [renderConfigDirty, setRenderConfigDirty] = useState(false);
  const [diagnostics, setDiagnostics] =
    useState<ActionDiagnostics | null>(null);
  const [draftDiagnostics, setDraftDiagnostics] =
    useState<ActionDiagnostics | null>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [advancedPreviewZoom, setAdvancedPreviewZoom] = useState(1.15);
  const [advancedPreviewBaseScaleLock, setAdvancedPreviewBaseScaleLock] =
    useState<number | null>(null);
  const [modulePickerOpen, setModulePickerOpen] = useState(false);
  const [voiceLineAudioUrl, setVoiceLineAudioUrl] = useState("");
  const stageRef = useRef<HTMLDivElement | null>(null);
  const advancedPointerCleanupRef = useRef<(() => void) | null>(null);
  const editLockedPetIdRef = useRef<string | null>(null);
  const draftOwnerPetIdRef = useRef<string | null>(null);
  const draftPersistenceRef = useRef<{
    petId: string;
    draft: PetRenderConfig;
  } | null>(null);

  const currentPetForDraft = state
    ? state.pets.find((item) => item.id === state.activePetId) || state.pets[0]
    : null;
  draftPersistenceRef.current =
    currentPetForDraft &&
    draftOwnerPetIdRef.current === currentPetForDraft.id &&
    draftRenderConfig &&
    renderConfigDirty
      ? { petId: currentPetForDraft.id, draft: draftRenderConfig }
      : null;

  useEffect(() => {
    if (!state) return;
    const currentPet =
      state.pets.find((item) => item.id === state.activePetId) ||
      state.pets[0];
    if (!currentPet.spine) {
      setDiagnostics(null);
      return;
    }
    setDiagnostics(
      validateActionSet(
        currentPet.spine.animations,
        currentPet.spine.animationDurations || {},
        currentPet.actionBindings
      )
    );
  }, [
    state?.activePetId,
    state?.pets
  ]);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const update = () =>
      setStageSize({
        width: element.clientWidth,
        height: element.clientHeight
      });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mode]);

  useEffect(() => {
    if (!state) return;
    const currentPet =
      state.pets.find((item) => item.id === state.activePetId) ||
      state.pets[0];
    if (!currentPet) return;
    restoreAdvancedRenderDraft(currentPet.id, currentPet.renderConfig);
  }, [state?.activePetId]);

  useEffect(() => {
    if (showAdvanced) return;
    advancedPointerCleanupRef.current?.();
  }, [showAdvanced]);

  useEffect(() => {
    const pendingDraft = draftPersistenceRef.current;
    if (!pendingDraft) return;
    writeAdvancedRenderDraft(pendingDraft.petId, pendingDraft.draft);
  }, [draftRenderConfig, renderConfigDirty, state?.activePetId]);

  useEffect(() => {
    if (!state) return;
    const currentPet =
      state.pets.find((item) => item.id === state.activePetId) || state.pets[0];
    const shouldLock = Boolean(showAdvanced && mode === "edit" && currentPet);
    const lockedPetId = editLockedPetIdRef.current;
    if (lockedPetId && (!shouldLock || lockedPetId !== currentPet?.id)) {
      void window.deskPet
        .overlayCommand({
          type: "edit-lock",
          petId: lockedPetId,
          locked: false
        } as never)
        .catch(() => undefined);
      editLockedPetIdRef.current = null;
    }
    if (shouldLock && currentPet && lockedPetId !== currentPet.id) {
      void window.deskPet
        .overlayCommand({
          type: "edit-lock",
          petId: currentPet.id,
          locked: true
        } as never)
        .catch(() => undefined);
      editLockedPetIdRef.current = currentPet.id;
    }
  }, [mode, showAdvanced, state?.activePetId, state?.pets]);

  useEffect(
    () => () => {
      advancedPointerCleanupRef.current?.();
      const pendingDraft = draftPersistenceRef.current;
      if (pendingDraft) {
        writeAdvancedRenderDraft(pendingDraft.petId, pendingDraft.draft);
      }
      const lockedPetId = editLockedPetIdRef.current;
      if (lockedPetId) {
        void window.deskPet
          .overlayCommand({
            type: "edit-lock",
            petId: lockedPetId,
            locked: false
          } as never)
          .catch(() => undefined);
      }
    },
    []
  );

  if (!state) return null;
  const currentState = state;
  const pet =
    currentState.pets.find((item) => item.id === currentState.activePetId) ||
    currentState.pets[0];
    const autoTextEnabled =
      pet.autoTextEnabled ?? pet.autoDialogueEnabled ?? true;
    const autoVoiceEnabled =
      pet.autoVoiceEnabled ?? pet.autoDialogueEnabled ?? true;
  const activeRenderConfig: PetRenderConfig =
    draftRenderConfig || withRenderConfigDefaults(pet.renderConfig);

  function restoreAdvancedRenderDraft(
    petId: string,
    savedConfig?: Partial<PetRenderConfig> | null
  ) {
    const restoredDraft = readAdvancedRenderDraft(petId);
    draftOwnerPetIdRef.current = petId;
    setDraftRenderConfig(
      restoredDraft || withRenderConfigDefaults(savedConfig)
    );
    setRenderConfigDirty(restoredDraft !== null);
  }

  async function savePet(nextPet: PetProfile) {
    const originalName = nextPet.name;
    const others = currentState.pets.filter((item) => item.id !== nextPet.id);
    let name = originalName;
    if (others.some((item) => item.name === name)) {
      name = makeUniqueName(name, others.map((item) => item.name));
    }
    nextPet = { ...nextPet, name, updatedAt: new Date().toISOString() };
    const renamed = name !== originalName;
    await updateState({
      pets: currentState.pets.map((item) =>
        item.id === nextPet.id ? nextPet : item
      ),
      activePetId: nextPet.id
    });
    setPetNameError("");
  }

  function saveModulePlugin(patch: Partial<PetModulePlugins>) {
    void savePet({
      ...pet,
      modulePlugins: {
        ...(pet.modulePlugins || {}),
        ...patch
      }
    });
  }

  function saveCustomModulePlugin(
    source: "voice" | "ai" | "training",
    itemId: string
  ) {
    saveModulePlugin({
      custom: itemId ? { source, itemId } : undefined
    });
  }

  const voiceLines: PetVoiceLines = pet.voiceLines || {
    enabled: true,
    intervalSeconds: 60,
    probability: 60,
    clips: []
  };

  async function saveVoiceLines(patch: Partial<PetVoiceLines>) {
    await savePet({
      ...pet,
      voiceLines: { ...voiceLines, ...patch }
    });
  }

  async function importVoiceLines() {
    const result = await window.deskPet.importVoiceLines(pet.id);
    if (result.canceled) return;
    await refresh();
  }

  function previewVoiceLine(clip: PetVoiceClip) {
    if (!clip.url) return;
    setVoiceLineAudioUrl(clip.url);
  }

  async function deletePet() {
    if (currentState.pets.length <= 1) return;
    if (!window.confirm(`确定删除“${pet.name}”吗？素材仍会保留在数据目录中。`)) {
      return;
    }
    const pets = currentState.pets.filter((item) => item.id !== pet.id);
    await updateState({ pets, activePetId: pets[0].id });
    clearAdvancedRenderDraft(pet.id);
    setMode("edit");
  }

  async function startCreate() {
    if (!(await resolveUnsavedRenderConfig())) return;
    clearAdvancedRenderDraft(pet.id);
    setMode("create");
    setDraftId(makeId("spine-draft"));
    setDraftParts({});
    setDraftDiagnostics(null);
    setPreviewAction("");
    setShowAdvanced(false);
  }

  async function selectPart(kind: SpinePartKind) {
    try {
      const result = await window.deskPet.selectSpinePart(kind, draftId);
      if (result.part) {
        setDraftParts((current) => ({ ...current, [kind]: result.part }));
        if (kind === "skeleton") {
          await inspectSkeletonPart(result.part);
        }
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "素材导入失败。");
    }
  }

  async function inspectSkeletonPart(part: SpineStagedPart) {
    try {
      const response = await fetch(part.url);
      const buffer = await response.arrayBuffer();
      const makeAttachment = () => ({ color: new Color() });
      const loader = {
        newRegionAttachment: makeAttachment,
        newMeshAttachment: makeAttachment,
        newBoundingBoxAttachment: makeAttachment,
        newPathAttachment: makeAttachment,
        newPointAttachment: makeAttachment,
        newClippingAttachment: makeAttachment
      };
      const parser = new SkeletonBinary(loader as never);
      const data = parser.readSkeletonData(new Uint8Array(buffer));
      const animations = data.animations.map((animation) => animation.name);
      const durations = Object.fromEntries(
        data.animations.map((animation) => [
          animation.name,
          animation.duration
        ])
      );
      setDraftDiagnostics(validateActionSet(animations, durations));
    } catch {
      setDraftDiagnostics({
        status: "invalid",
        title: "该文件不能驱动模型运动",
        message: "无法读取骨骼动画数据，请重新导入正确的 .skel 文件。",
        missing: []
      });
    }
  }

  async function createPetFromSpine() {
    if (
      !draftParts.skeleton ||
      !draftParts.atlas ||
      !draftParts.texture ||
      creating ||
      draftDiagnostics?.status === "invalid"
    ) {
      return;
    }

    setCreating(true);
    try {
      const result = await window.deskPet.createPetFromSpine(
        draftId,
        {
          skeleton: draftParts.skeleton,
          atlas: draftParts.atlas,
          texture: draftParts.texture
        }
      );
      if (!result.ok) {
        window.alert(result.error || "创建桌宠失败。");
        return;
      }
      setDraftParts({});
      setDraftDiagnostics(null);
      await refresh();
      setMode("edit");
    } finally {
      setCreating(false);
    }
  }

  function saveSpineAnimations(animations: string[]) {
    if (!pet.spine) return;
    if (pet.spine.animations.join("|") === animations.join("|")) return;
    void savePet({
      ...pet,
      spine: {
        ...pet.spine,
        animations
      }
    });
  }

  function saveSkeletonInfo(info: {
    animations: string[];
    durations: Record<string, number>;
    boneMap: BoneRoleMap;
  }) {
    if (!pet.spine) return;
    const inferredBindings = { ...(pet.actionBindings || {}) };
    for (const action of universalActions) {
      if (!inferredBindings[action.id]) {
        const match = chooseBoundAnimation(
          action.id,
          undefined,
          info.animations,
          info.durations
        );
        if (match) inferredBindings[action.id] = match;
      }
    }
    setDiagnostics(
      validateActionSet(info.animations, info.durations, inferredBindings)
    );
    const bindingsChanged =
      JSON.stringify(inferredBindings) !==
      JSON.stringify(pet.actionBindings || {});
    const boneMapChanged =
      JSON.stringify(info.boneMap) !== JSON.stringify(pet.boneMap || {});
    if (bindingsChanged || boneMapChanged) {
      void savePet({
        ...pet,
        actionBindings: inferredBindings,
        boneMap: {
          ...(pet.boneMap || {}),
          ...info.boneMap
        },
        spine: {
          ...pet.spine,
          animations: info.animations,
          animationDurations: info.durations
        }
      });
    }
  }

  function updateActionBinding(actionId: string, animation: string) {
    const nextBindings = {
      ...(pet.actionBindings || {}),
      [actionId]: animation
    };
    void savePet({ ...pet, actionBindings: nextBindings });
    setDiagnostics(
      validateActionSet(
        pet.spine?.animations || [],
        pet.spine?.animationDurations || {},
        nextBindings
      )
    );
  }

  function previewBoundAction(actionId: string) {
    const animation =
      pet.actionBindings?.[actionId] ||
      chooseBoundAnimation(
        actionId,
        undefined,
        pet.spine?.animations || [],
        pet.spine?.animationDurations || {}
      );
    if (!animation) {
      window.alert("这个角色没有可预览的对应动画。");
      return;
    }
    setPreviewAction(animation);
    window.setTimeout(() => setPreviewAction(""), 3200);
  }

  function saveRenderConfig(patch: Partial<NonNullable<PetProfile["renderConfig"]>>) {
    draftOwnerPetIdRef.current = pet.id;
    setDraftRenderConfig((current) => ({
      ...withRenderConfigDefaults(current || pet.renderConfig),
      ...patch
    }));
    setRenderConfigDirty(true);
  }

  async function commitRenderConfig() {
    const nextRenderConfig = withRenderConfigDefaults({
      ...(pet.renderConfig || {}),
      ...activeRenderConfig
    });
    await savePet({
      ...pet,
      renderConfig: nextRenderConfig,
      desktopRenderConfig: nextRenderConfig
    });
    draftOwnerPetIdRef.current = pet.id;
    setDraftRenderConfig(nextRenderConfig);
    setRenderConfigDirty(false);
    clearAdvancedRenderDraft(pet.id);
  }

  async function resolveUnsavedRenderConfig() {
    if (!renderConfigDirty) return true;
    const shouldSave = window.confirm(
      "高级设置有未保存的改动。\n\n点击“确定”保存并继续；点击“取消”后再选择是否放弃。"
    );
    if (shouldSave) {
      await commitRenderConfig();
      return true;
    }
    const shouldDiscard = window.confirm(
      "是否放弃本次高级设置改动？\n\n点击“确定”放弃；点击“取消”留在当前角色继续编辑。"
    );
    if (!shouldDiscard) return false;
    draftOwnerPetIdRef.current = pet.id;
    setDraftRenderConfig(withRenderConfigDefaults(pet.renderConfig));
    setRenderConfigDirty(false);
    clearAdvancedRenderDraft(pet.id);
    return true;
  }

  async function toggleAdvancedSettings() {
    if (!showAdvanced) {
      restoreAdvancedRenderDraft(pet.id, pet.renderConfig);
      setShowAdvanced(true);
      return;
    }
    if (!(await resolveUnsavedRenderConfig())) return;
    clearAdvancedRenderDraft(pet.id);
    setShowAdvanced(false);
  }

  function getAdvancedPreviewScale(config: Partial<PetRenderConfig>) {
    const width = config.displayWidth || 260;
    const height = config.displayHeight || 320;
    if (stageSize.width <= 0 || stageSize.height <= 0) return 1;
    return Math.max(
      0.2,
      Math.min(
        1.6,
        (stageSize.width - 64) / width,
        (stageSize.height - 64) / height
      )
    );
  }

  function beginAdvancedPointerSession(
    event: React.PointerEvent,
    getPatch: (dx: number, dy: number) => Partial<PetRenderConfig>,
    lockPreviewBase = false
  ) {
    event.preventDefault();
    event.stopPropagation();
    advancedPointerCleanupRef.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    const captureTarget = event.currentTarget as HTMLElement;
    const pointerId = event.pointerId;
    const startDraft = withRenderConfigDefaults(activeRenderConfig);
    const savedDraft = withRenderConfigDefaults(pet.renderConfig);
    draftOwnerPetIdRef.current = pet.id;
    const lockedPreviewBase = lockPreviewBase
      ? getAdvancedPreviewScale(startDraft)
      : null;
    if (lockedPreviewBase !== null) {
      setAdvancedPreviewBaseScaleLock(lockedPreviewBase);
    }
    const previewScale =
      (lockedPreviewBase ?? getAdvancedPreviewScale(startDraft)) *
      advancedPreviewZoom;
    let frame: number | null = null;
    let pendingPoint: { x: number; y: number } | null = null;
    let captureActive = false;
    let previewBaseLockActive = lockedPreviewBase !== null;

    const applyPendingPoint = () => {
      frame = null;
      if (!pendingPoint) return;
      const dx = (pendingPoint.x - startX) / previewScale;
      const dy = (pendingPoint.y - startY) / previewScale;
      pendingPoint = null;
      setDraftRenderConfig({
        ...startDraft,
        ...getPatch(dx, dy)
      });
      setRenderConfigDirty(true);
    };

    const detach = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("keydown", handleKeyDown);
      captureTarget.removeEventListener(
        "lostpointercapture",
        handleLostPointerCapture
      );
      if (captureActive) {
        captureActive = false;
        try {
          if (captureTarget.hasPointerCapture(pointerId)) {
            captureTarget.releasePointerCapture(pointerId);
          }
        } catch {
          // Pointer capture can already be gone when the window loses focus.
        }
      }
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      if (previewBaseLockActive) {
        previewBaseLockActive = false;
        setAdvancedPreviewBaseScaleLock(null);
      }
      if (advancedPointerCleanupRef.current === detach) {
        advancedPointerCleanupRef.current = null;
      }
    };

    const cancel = () => {
      detach();
      setDraftRenderConfig(startDraft);
      setRenderConfigDirty(!hasSameRenderConfig(startDraft, savedDraft));
    };

    const handleMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (moveEvent.buttons === 0) {
        pendingPoint = { x: moveEvent.clientX, y: moveEvent.clientY };
        if (pendingPoint) applyPendingPoint();
        detach();
        return;
      }
      moveEvent.preventDefault();
      pendingPoint = { x: moveEvent.clientX, y: moveEvent.clientY };
      if (frame === null) frame = requestAnimationFrame(applyPendingPoint);
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      if (pendingPoint) applyPendingPoint();
      detach();
    };

    const handlePointerCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== pointerId) return;
      cancel();
    };

    const handleLostPointerCapture = (lostEvent: PointerEvent) => {
      if (lostEvent.pointerId !== pointerId) return;
      cancel();
    };

    const handleBlur = () => cancel();

    const handleKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      cancel();
    };

    try {
      captureTarget.setPointerCapture(pointerId);
      captureActive = true;
    } catch {
      // Window-level listeners still keep dragging usable without capture.
    }

    advancedPointerCleanupRef.current = detach;
    if (captureActive) {
      captureTarget.addEventListener(
        "lostpointercapture",
        handleLostPointerCapture
      );
    }
    window.addEventListener("pointermove", handleMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    window.addEventListener("blur", handleBlur);
    window.addEventListener("keydown", handleKeyDown);
  }

  function beginAdvancedDrag(
    event: React.PointerEvent,
    kind: "display" | "hitbox" | "hitboxMove" | "model"
  ) {
    const start = withRenderConfigDefaults(activeRenderConfig);
    beginAdvancedPointerSession(event, (dx, dy) => {
      if (kind === "display") {
        return {
          displayWidth: Math.max(
            60,
            Math.round((start.displayWidth || 260) + dx)
          ),
          displayHeight: Math.max(
            80,
            Math.round((start.displayHeight || 320) + dy)
          )
        };
      } else if (kind === "hitbox") {
        return {
          hitboxWidth: Math.max(30, Math.round(start.hitboxWidth + dx)),
          hitboxHeight: Math.max(40, Math.round(start.hitboxHeight + dy))
        };
      } else if (kind === "hitboxMove") {
        return {
          hitboxOffsetX: Math.round(start.hitboxOffsetX + dx),
          hitboxOffsetY: Math.round(start.hitboxOffsetY + dy)
        };
      }
      const nextOffsetX = Math.round(start.offsetX + dx);
      const nextOffsetY = Math.round(start.offsetY + dy);
      const deltaX = nextOffsetX - start.offsetX;
      const deltaY = nextOffsetY - start.offsetY;
      return {
        offsetX: nextOffsetX,
        offsetY: nextOffsetY,
        hitboxOffsetX: Math.round(start.hitboxOffsetX + deltaX),
        hitboxOffsetY: Math.round(start.hitboxOffsetY + deltaY)
      };
    }, kind === "display");
  }

  function beginAdvancedResize(
    event: React.PointerEvent,
    mode: "display" | "hitbox",
    edge: AdvancedResizeEdge
  ) {
    const start = withRenderConfigDefaults(activeRenderConfig);
    const handlesLeft = edge.includes("w");
    const handlesRight = edge.includes("e");
    const handlesTop = edge.includes("n");
    const handlesBottom = edge.includes("s");

    beginAdvancedPointerSession(event, (rawDx, rawDy) => {
      const dx = Math.round(rawDx);
      const dy = Math.round(rawDy);
      const widthDelta = (handlesRight ? dx : 0) - (handlesLeft ? dx : 0);
      const heightDelta = (handlesBottom ? dy : 0) - (handlesTop ? dy : 0);

      if (mode === "hitbox") {
        const hitboxWidth = Math.max(20, Math.round(start.hitboxWidth + widthDelta));
        const hitboxHeight = Math.max(
          30,
          Math.round(start.hitboxHeight + heightDelta)
        );
        const actualWidthDelta = hitboxWidth - start.hitboxWidth;
        const actualHeightDelta = hitboxHeight - start.hitboxHeight;
        return {
          hitboxWidth,
          hitboxHeight,
          hitboxOffsetX: handlesLeft
            ? Math.round(start.hitboxOffsetX - actualWidthDelta / 2)
            : handlesRight
              ? Math.round(start.hitboxOffsetX + actualWidthDelta / 2)
              : start.hitboxOffsetX,
          hitboxOffsetY: handlesTop
            ? Math.round(start.hitboxOffsetY - actualHeightDelta / 2)
            : handlesBottom
              ? Math.round(start.hitboxOffsetY + actualHeightDelta / 2)
              : start.hitboxOffsetY
        };
      }
      return {
        displayWidth: Math.max(
          60,
          Math.round((start.displayWidth || 260) + widthDelta * 2)
        ),
        displayHeight: Math.max(
          80,
          Math.round((start.displayHeight || 320) + heightDelta * 2)
        )
      };
    }, mode === "display");
  }

  const canCreate =
    Boolean(draftParts.skeleton) &&
    Boolean(draftParts.atlas) &&
    Boolean(draftParts.texture) &&
    draftDiagnostics?.status !== "invalid";
    const rawDisplayWidth = activeRenderConfig.displayWidth || 260;
    const rawDisplayHeight = activeRenderConfig.displayHeight || 320;
    // 预览倍率必须作用于整套几何，避免画面框、角色和碰撞框比例不一致。
    const advancedPreviewBaseScale =
      advancedPreviewBaseScaleLock ?? getAdvancedPreviewScale(activeRenderConfig);
    const advancedScale = advancedPreviewBaseScale * advancedPreviewZoom;
    const advancedDisplayWidth = rawDisplayWidth * advancedScale;
    const advancedDisplayHeight = rawDisplayHeight * advancedScale;
    const advancedVisualWidth =
      (activeRenderConfig.visualWidth || 104) * advancedScale;
    const advancedVisualHeight =
      (activeRenderConfig.visualHeight || 134) * advancedScale;
    const advancedHitboxWidth = activeRenderConfig.hitboxWidth * advancedScale;
    const advancedHitboxHeight =
      activeRenderConfig.hitboxHeight * advancedScale;
    const advancedCenterX = stageSize.width / 2;
    const advancedCenterY = stageSize.height / 2;
    const advancedHitboxPosition = getHitboxPosition({
      displayWidth: advancedDisplayWidth,
      displayHeight: advancedDisplayHeight,
      hitboxWidth: advancedHitboxWidth,
      hitboxHeight: advancedHitboxHeight,
      hitboxOffsetX: activeRenderConfig.hitboxOffsetX * advancedScale,
      hitboxOffsetY: activeRenderConfig.hitboxOffsetY * advancedScale
    });

  return (
    <div className="workshop-layout">
      <aside className="pet-list-panel">
        <div className="panel-heading">
          <Layers3 size={18} />
          <h3>角色列表</h3>
        </div>
        <div className="pet-list">
          {currentState.pets.map((item) => (
            <button
              className={
                mode === "edit" && item.id === pet.id
                  ? "pet-list-item pet-list-item--active"
                  : "pet-list-item"
              }
              key={item.id}
              type="button"
              onClick={async () => {
                if (item.id === pet.id) return;
                if (!(await resolveUnsavedRenderConfig())) return;
                await updateState({ activePetId: item.id });
                clearAdvancedRenderDraft(pet.id);
                setMode("edit");
                setShowAdvanced(false);
              }}
            >
              <span className="pet-dot" style={{ background: item.accent }} />
              <div>
                <strong>{item.name}</strong>
                <span>{item.spine ? "Spine 角色" : "占位角色"}</span>
              </div>
              <span
                className={
                  currentState.summonedPetIds.includes(item.id)
                    ? "summoned-dot summoned-dot--active"
                    : "summoned-dot"
                }
                title={
                  currentState.summonedPetIds.includes(item.id)
                    ? "已在桌面召唤"
                    : "未召唤"
                }
              />
            </button>
          ))}
        </div>
        <button className="wide-secondary add-pet-button" type="button" onClick={startCreate}>
          <Plus size={17} />
          新增桌宠
        </button>
      </aside>

      <section className="pet-editor">
        <div className="editor-toolbar">
          <div>
            <span className="section-kicker">角色舞台</span>
            <h2>{mode === "create" ? "新增桌宠" : pet.name}</h2>
          </div>
          {mode === "edit" && (
            <div className="toolbar-buttons">
              <button
                className="toolbar-delete"
                type="button"
                style={{
                  color: "#fff",
                  background: "#d75d5d",
                  borderColor: "#d75d5d",
                  opacity: 1,
                  visibility: "visible"
                }}
                onClick={deletePet}
                disabled={state.pets.length <= 1}
              >
                <Trash2 size={16} />
                删除
              </button>
              <button
                className="primary-small"
                type="button"
                style={{
                  color: "#fff",
                  background: "#2f7df6",
                  borderColor: "#2f7df6",
                  opacity: 1,
                  visibility: "visible"
                }}
                onClick={() =>
                  renderConfigDirty ? commitRenderConfig() : savePet(pet)
                }
              >
                <Save size={16} />
                保存
              </button>
              <button
                className="advanced-settings-button"
                type="button"
                style={{
                  color: "#fff",
                  background: "#2b9a67",
                  borderColor: "#2b9a67",
                  opacity: 1,
                  visibility: "visible"
                }}
                onClick={toggleAdvancedSettings}
                aria-pressed={showAdvanced}
              >
                <SlidersHorizontal size={15} />
                {showAdvanced ? "完成高级设置" : "高级设置"}
              </button>
            </div>
          )}
        </div>

        <div
          ref={stageRef}
          className={[
            "workshop-stage",
            mode === "create" ? "workshop-stage--empty" : "",
            showAdvanced ? "workshop-stage--advanced" : ""
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <div className="workshop-platform" />
          {mode === "create" ? (
            <div className="workshop-empty-copy">
              <ImageIcon size={32} />
              <strong>等待导入新桌宠素材</strong>
              <span>请在右侧依次导入骨骼、图集和纹理文件</span>
            </div>
          ) : pet.spine ? (
            <SpinePet
              skelUrl={pet.spine.skelUrl}
              state="idle"
              fitRatio={showAdvanced ? 1 : 0.72}
              maxFPS={30}
              deferMountMs={160}
              fitWidth={
                showAdvanced
                  ? advancedVisualWidth
                  : undefined
              }
              fitHeight={
                showAdvanced
                  ? advancedVisualHeight
                  : undefined
              }
              displayWidth={showAdvanced ? advancedDisplayWidth : undefined}
              displayHeight={showAdvanced ? advancedDisplayHeight : undefined}
              offsetX={
                showAdvanced
                  ? activeRenderConfig.offsetX * advancedScale
                  : -28 + activeRenderConfig.offsetX
              }
              offsetY={
                showAdvanced
                  ? activeRenderConfig.offsetY * advancedScale
                  : activeRenderConfig.offsetY
              }
              anchorBottom={false}
              normalizeBodySize={false}
              className="workshop-spine-pet"
              onAnimations={saveSpineAnimations}
              onSkeletonInfo={saveSkeletonInfo}
              actionBindings={pet.actionBindings}
              actionOverride={previewAction}
              boneMap={pet.boneMap}
              fallback={
                <PetAvatar
                  primary={pet.accent}
                  secondary={pet.secondary}
                  size={150 * pet.scale}
                  state="idle"
                />
              }
            />
          ) : pet.avatarUrl ? (
            <img
              src={pet.avatarUrl}
              alt={pet.name}
              className="workshop-pet-image"
              style={{ transform: `scale(${pet.scale})` }}
            />
          ) : (
            <PetAvatar
              primary={pet.accent}
              secondary={pet.secondary}
              size={150 * pet.scale}
              state="idle"
            />
          )}
          {mode === "edit" && showAdvanced && (
            <div className="advanced-stage-editor">
              <div className="advanced-stage-label">高级设置中</div>
              {advancedMode === "position" && (
                <div
                  className="advanced-display-frame advanced-display-frame--guide"
                  style={{
                    left: advancedCenterX - advancedDisplayWidth / 2,
                    top: advancedCenterY - advancedDisplayHeight / 2,
                    width: advancedDisplayWidth,
                    height: advancedDisplayHeight
                  }}
                  onPointerDown={(event) => beginAdvancedDrag(event, "model")}
                >
                  <span className="advanced-frame-label">拖动角色位置</span>
                </div>
              )}
              {advancedMode === "display" && (
                <div
                  className="advanced-display-frame"
                  style={{
                    left: advancedCenterX - advancedDisplayWidth / 2,
                    top: advancedCenterY - advancedDisplayHeight / 2,
                    width: advancedDisplayWidth,
                    height: advancedDisplayHeight
                  }}
                >
                  <span className="advanced-frame-label">显示画面框</span>
                  {advancedResizeEdges.map((edge) => (
                    <span
                      className={`advanced-resize-edge advanced-resize-edge--${edge}`}
                      key={edge}
                      onPointerDown={(event) =>
                        beginAdvancedResize(event, "display", edge)
                      }
                    />
                  ))}
                </div>
              )}
              {advancedMode === "hitbox" && (
                <div
                  className="advanced-hitbox-frame"
                  style={{
                    left:
                      advancedCenterX -
                      advancedDisplayWidth / 2 +
                      advancedHitboxPosition.left,
                    top:
                      advancedCenterY -
                      advancedDisplayHeight / 2 +
                      advancedHitboxPosition.top,
                    width: advancedHitboxWidth,
                    height: advancedHitboxHeight
                  }}
                  onPointerDown={(event) =>
                    beginAdvancedDrag(event, "hitboxMove")
                  }
                >
                  <span className="advanced-frame-label">碰撞区域框</span>
                  {advancedResizeEdges.map((edge) => (
                    <span
                      className={`advanced-resize-edge advanced-resize-edge--${edge}`}
                      key={edge}
                      onPointerDown={(event) =>
                        beginAdvancedResize(event, "hitbox", edge)
                      }
                    />
                  ))}
                </div>
              )}
            </div>
          )}
          {mode === "edit" && !showAdvanced && (
            <>
              <label className="stage-character-name">
                <span>角色名</span>
                <input
                  defaultValue={pet.name}
                  key={`${pet.id}-stage-name`}
                  onBlur={(event) => {
                    const name = event.target.value.trim();
                    const others = currentState.pets.filter(
                      (item) => item.id !== pet.id
                    );
                    if (others.some((item) => item.name === name)) {
                      setPetNameError("名字已存在");
                      return;
                    }
                    setPetNameError("");
                    void savePet({ ...pet, name });
                  }}
                />
                {petNameError && (
                  <span className="name-error">名字已存在</span>
                )}
              </label>
              <label className="stage-character-size">
                <span>基础尺寸</span>
                <input
                  type="range"
                  min="0.5"
                  max="3"
                  step="0.05"
                  value={pet.scale}
                  onChange={(event) =>
                    savePet({ ...pet, scale: Number(event.target.value) })
                  }
                />
                <strong>{pet.scale.toFixed(2)}x</strong>
              </label>
            </>
          )}
        </div>

        {mode === "edit" && (
          <div className="editor-fields editor-fields--compact">
            {showAdvanced ? (
              <>
                <div className="advanced-mode-tabs">
                  <button
                    className={
                      advancedMode === "position"
                        ? "advanced-mode-button advanced-mode-button--active"
                        : "advanced-mode-button"
                    }
                    type="button"
                    onClick={() => setAdvancedMode("position")}
                  >
                    角色位置调试
                  </button>
                  <button
                    className={
                      advancedMode === "hitbox"
                        ? "advanced-mode-button advanced-mode-button--active"
                        : "advanced-mode-button"
                    }
                    type="button"
                    onClick={() => setAdvancedMode("hitbox")}
                  >
                    碰撞区域调试
                  </button>
                  <button
                    className={
                      advancedMode === "display"
                        ? "advanced-mode-button advanced-mode-button--active"
                        : "advanced-mode-button"
                    }
                    type="button"
                    onClick={() => setAdvancedMode("display")}
                  >
                    显示画面调试
                  </button>
                </div>
                  <label className="range-field advanced-preview-zoom">
                    <span>编辑预览放大</span>
                    <input
                      type="range"
                      min="1"
                      max="3"
                      step="0.1"
                      value={advancedPreviewZoom}
                      onChange={(event) =>
                        setAdvancedPreviewZoom(Number(event.target.value))
                      }
                    />
                    <strong>{advancedPreviewZoom.toFixed(2)}x</strong>
                  </label>
                <div className="advanced-slider-grid">
                  {advancedMode === "position" && (
                    <>
                      <label className="range-field">
                        <span>水平位置</span>
                        <input
                          type="range"
                          min="-200"
                          max="200"
                          step="2"
                          value={activeRenderConfig.offsetX}
                          onChange={(event) => {
                            const offsetX = Number(event.target.value);
                            const delta = offsetX - activeRenderConfig.offsetX;
                            saveRenderConfig({
                              offsetX,
                              hitboxOffsetX: Math.round(
                                activeRenderConfig.hitboxOffsetX + delta
                              )
                            });
                          }}
                        />
                        <strong>{activeRenderConfig.offsetX}</strong>
                      </label>
                      <label className="range-field">
                        <span>垂直位置</span>
                        <input
                          type="range"
                          min="-200"
                          max="200"
                          step="2"
                          value={activeRenderConfig.offsetY}
                          onChange={(event) => {
                            const offsetY = Number(event.target.value);
                            const delta = offsetY - activeRenderConfig.offsetY;
                            saveRenderConfig({
                              offsetY,
                              hitboxOffsetY: Math.round(
                                activeRenderConfig.hitboxOffsetY + delta
                              )
                            });
                          }}
                        />
                        <strong>{activeRenderConfig.offsetY}</strong>
                      </label>
                    </>
                  )}
                  {advancedMode === "hitbox" && (
                    <>
                      <label className="range-field">
                        <span>碰撞宽度</span>
                        <input
                          type="range"
                          min="40"
                          max="300"
                          step="2"
                          value={activeRenderConfig.hitboxWidth}
                          onChange={(event) =>
                            saveRenderConfig({
                              hitboxWidth: Number(event.target.value)
                            })
                          }
                        />
                        <strong>{activeRenderConfig.hitboxWidth}</strong>
                      </label>
                      <label className="range-field">
                        <span>碰撞高度</span>
                        <input
                          type="range"
                          min="60"
                          max="420"
                          step="2"
                          value={activeRenderConfig.hitboxHeight}
                          onChange={(event) =>
                            saveRenderConfig({
                              hitboxHeight: Number(event.target.value)
                            })
                          }
                        />
                        <strong>{activeRenderConfig.hitboxHeight}</strong>
                      </label>
                      <label className="range-field">
                        <span>水平偏移</span>
                        <input
                          type="range"
                          min="-200"
                          max="200"
                          step="2"
                          value={activeRenderConfig.hitboxOffsetX}
                          onChange={(event) =>
                            saveRenderConfig({
                              hitboxOffsetX: Number(event.target.value)
                            })
                          }
                        />
                        <strong>{activeRenderConfig.hitboxOffsetX}</strong>
                      </label>
                      <label className="range-field">
                        <span>垂直偏移</span>
                        <input
                          type="range"
                          min="-200"
                          max="200"
                          step="2"
                          value={activeRenderConfig.hitboxOffsetY}
                          onChange={(event) =>
                            saveRenderConfig({
                              hitboxOffsetY: Number(event.target.value)
                            })
                          }
                        />
                        <strong>{activeRenderConfig.hitboxOffsetY}</strong>
                      </label>
                    </>
                  )}
                  {advancedMode === "display" && (
                    <>
                      <label className="range-field">
                        <span>画面宽度</span>
                        <input
                          type="range"
                          min="60"
                          max="1200"
                          step="2"
                          value={activeRenderConfig.displayWidth || 260}
                          onChange={(event) =>
                            saveRenderConfig({
                              displayWidth: Number(event.target.value)
                            })
                          }
                        />
                        <strong>{activeRenderConfig.displayWidth || 260}</strong>
                      </label>
                      <label className="range-field">
                        <span>画面高度</span>
                        <input
                          type="range"
                          min="80"
                          max="1400"
                          step="2"
                          value={activeRenderConfig.displayHeight || 320}
                          onChange={(event) =>
                            saveRenderConfig({
                              displayHeight: Number(event.target.value)
                            })
                          }
                        />
                        <strong>{activeRenderConfig.displayHeight || 320}</strong>
                      </label>
                      <label className="range-field">
                        <span>角色宽度</span>
                        <input
                          type="range"
                          min="40"
                          max="800"
                          step="2"
                          value={activeRenderConfig.visualWidth || 104}
                          onChange={(event) =>
                            saveRenderConfig({
                              visualWidth: Number(event.target.value)
                            })
                          }
                        />
                        <strong>{activeRenderConfig.visualWidth || 104}</strong>
                      </label>
                      <label className="range-field">
                        <span>角色高度</span>
                        <input
                          type="range"
                          min="60"
                          max="900"
                          step="2"
                          value={activeRenderConfig.visualHeight || 134}
                          onChange={(event) =>
                            saveRenderConfig({
                              visualHeight: Number(event.target.value)
                            })
                          }
                        />
                        <strong>{activeRenderConfig.visualHeight || 134}</strong>
                      </label>
                    </>
                  )}
                </div>
                <div className="advanced-save-row">
                  <button
                    className="advanced-save-button"
                    type="button"
                    disabled={!renderConfigDirty}
                    onClick={() => void commitRenderConfig()}
                  >
                    保存高级设置
                  </button>
                  <span>
                    {renderConfigDirty
                      ? "有未保存的改动"
                      : "当前设置已保存"}
                  </span>
                </div>
                <button
                  className="advanced-future-button"
                  type="button"
                  disabled
                >
                  创建平面图片角色（预留）
                </button>
              </>
            ) : (
              <>
                <div className="module-plugin-panel">
                  <div className="module-plugin-heading">
                    <Puzzle size={16} />
                    <strong>模组插件</strong>
                  </div>
                  <div className="module-plugin-list">
                    <div className="module-plugin-row">
                      <span className="module-plugin-name">
                        <Volume2 size={15} />
                        语音插件
                      </span>
                      <select
                        value={pet.modulePlugins?.voiceProfileId || ""}
                        onChange={(event) =>
                          saveModulePlugin({
                            voiceProfileId: event.target.value || undefined
                          })
                        }
                      >
                        <option value="">未绑定声音档案</option>
                        {(state.voiceProfiles || []).map((profile) => (
                          <option value={profile.id} key={profile.id}>
                            {profile.name}
                          </option>
                        ))}
                      </select>
                      <span className="module-plugin-kind">声音档案</span>
                    </div>

                    <div className="module-plugin-row">
                      <span className="module-plugin-name">
                        <Bot size={15} />
                        角色档案
                      </span>
                      <select
                        value={pet.modulePlugins?.aiModuleId || ""}
                        onChange={(event) =>
                          saveModulePlugin({
                            aiModuleId: event.target.value || undefined
                          })
                        }
                      >
                        <option value="">未绑定角色档案</option>
                        {(state.trainingProfiles || []).filter((profile) => profile.status !== "draft").map((profile) => (
                          <option value={profile.id} key={profile.id}>
                            {profile.name}
                          </option>
                        ))}
                      </select>
                      <span className="module-plugin-kind">角色档案</span>
                    </div>

                    <div className="module-plugin-row module-plugin-row--bound">
                      <span className="module-plugin-name">
                        <Puzzle size={15} />
                        模组
                      </span>
                      <div className="module-bound-selector">
                        <button
                          className="module-picker-toggle"
                          type="button"
                          onClick={() =>
                            setModulePickerOpen((current) => !current)
                          }
                        >
                          <Plus size={13} />
                          添加模组
                        </button>
                        {modulePickerOpen && (
                          <div className="module-add-menu">
                            {(state.customModules || [])
                              .filter(
                                (module) =>
                                  module.enabled !== false &&
                                  !(
                                    pet.modulePlugins?.boundModuleIds || []
                                  ).includes(module.id)
                              )
                              .map((module) => (
                                <button
                                  type="button"
                                  key={module.id}
                                  onClick={() => {
                                    saveModulePlugin({
                                      boundModuleIds: [
                                        ...new Set([
                                          ...(pet.modulePlugins?.boundModuleIds ||
                                            []),
                                          module.id
                                        ])
                                      ]
                                    });
                                  }}
                                >
                                  <Plus size={13} />
                                  {module.contextMenuLabel || module.name}
                                </button>
                              ))}
                            {(state.customModules || []).filter(
                              (module) =>
                                module.enabled !== false &&
                                !(
                                  pet.modulePlugins?.boundModuleIds || []
                                ).includes(module.id)
                            ).length === 0 && (
                              <span className="empty-copy">
                                没有可添加的模组。
                              </span>
                            )}
                          </div>
                        )}
                        <div className="module-bound-list">
                          {(pet.modulePlugins?.boundModuleIds || [])
                            .map((moduleId) =>
                              state.customModules.find(
                                (module) => module.id === moduleId
                              )
                            )
                            .filter(
                              (module) => Boolean(module)
                            )
                            .map((module) => (
                              <span
                                className={
                                  module!.enabled === false
                                    ? "module-bound-chip module-bound-chip--disabled"
                                    : "module-bound-chip"
                                }
                                key={module!.id}
                              >
                                {module!.contextMenuLabel || module!.name}
                                {module!.enabled === false ? "（已停用）" : ""}
                                <button
                                  type="button"
                                  onClick={() =>
                                    saveModulePlugin({
                                      boundModuleIds: (
                                        pet.modulePlugins?.boundModuleIds || []
                                      ).filter((id) => id !== module!.id)
                                    })
                                  }
                                >
                                  <X size={12} />
                                </button>
                              </span>
                            ))}
                        </div>
                      </div>
                      <span className="module-plugin-kind">右键菜单</span>
                    </div>

                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </section>

      <aside className="asset-panel">
        <div className="panel-heading">
          <ScanLine size={18} />
          <h3>{mode === "create" ? "素材与动作" : "角色动作"}</h3>
        </div>

        {mode === "create" ? (
          <>
            <div className="spine-import-slots">
              {spineSlots.map((slot) => {
                const Icon = slot.icon;
                const part = draftParts[slot.kind];
                return (
                  <button
                    className={
                      part
                        ? "spine-import-slot spine-import-slot--ready"
                        : "spine-import-slot"
                    }
                    key={slot.kind}
                    type="button"
                    onClick={() => selectPart(slot.kind)}
                  >
                    <span className="spine-import-icon">
                      {part ? <CheckCircle2 size={19} /> : <Icon size={19} />}
                    </span>
                    <span className="spine-import-copy">
                      <strong>{slot.label}</strong>
                      <small>{part ? part.name : slot.hint}</small>
                    </span>
                    <Upload size={15} />
                  </button>
                );
              })}
            </div>

            {draftDiagnostics && (
              <div
                className={`spine-diagnostics spine-diagnostics--${draftDiagnostics.status}`}
              >
                <strong>{draftDiagnostics.title}</strong>
                <p>{draftDiagnostics.message}</p>
              </div>
            )}

            <button
              className="primary-small wide-secondary create-spine-pet"
              type="button"
              disabled={!canCreate || creating}
              onClick={createPetFromSpine}
            >
              <Plus size={17} />
              {creating ? "正在创建..." : "创建桌宠"}
            </button>

            <div className="asset-note">
              <strong>创建规则</strong>
              <p>
                依次导入 `.skel`、`.atlas` 和纹理图片。图片会自动转换为图集要求的尺寸。
              </p>
            </div>
          </>
        ) : pet.spine ? (
          <>
            <div className="spine-summary">
              <strong>当前角色：Spine 3.8</strong>
              <span>
                {pet.spine.animations.join(" / ") || "正在读取动画..."}
              </span>
            </div>
            {diagnostics && (
              <div
                className={`spine-diagnostics spine-diagnostics--${diagnostics.status}`}
              >
                <strong>{diagnostics.title}</strong>
                <p>{diagnostics.message}</p>
              </div>
            )}
            <div className="action-preset-panel">
              <div className="panel-heading">
                <Layers3 size={17} />
                <h3>动作预设</h3>
              </div>
              <div className="action-preset-list">
                {universalActions.map((action) => (
                  <div className="action-preset-row" key={action.id}>
                    <div>
                      <strong>{action.label}</strong>
                      <span>{action.description}</span>
                    </div>
                    <select
                      value={pet.actionBindings?.[action.id] || ""}
                      onChange={(event) =>
                        updateActionBinding(action.id, event.target.value)
                      }
                    >
                      <option value="">通用动作</option>
                      {action.id === "walk" && (
                        <option value={FIRST_PET_LEG_WALK}>
                          {FIRST_PET_LEG_WALK_LABEL}
                        </option>
                      )}
                      {(pet.spine?.animations || []).map((animation) => (
                        <option value={animation} key={animation}>
                          {animation}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => previewBoundAction(action.id)}
                    >
                      播放
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="action-preset-panel">
              <div className="panel-heading">
                <AudioLines size={17} />
                <h3>角色语音</h3>
              </div>
              <p className="voice-line-hint">
                导入 WAV 音频后，桌宠在桌面上会按下面的间隔随机说话：时间到了也有概率说、有概率不说。
              </p>
              <label className="voice-line-toggle">
                <span>启用角色语音</span>
                <input
                  type="checkbox"
                  checked={voiceLines.enabled}
                  onChange={(event) =>
                    void saveVoiceLines({ enabled: event.target.checked })
                  }
                />
              </label>
              <label className="range-field">
                <span>播放间隔</span>
                <input
                  type="range"
                  min="10"
                  max="900"
                  step="10"
                  value={voiceLines.intervalSeconds}
                  onChange={(event) =>
                    void saveVoiceLines({
                      intervalSeconds: Number(event.target.value)
                    })
                  }
                />
                <strong>
                  {formatVoiceInterval(voiceLines.intervalSeconds)}
                </strong>
              </label>
              <label className="range-field">
                <span>播放概率</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  value={voiceLines.probability}
                  onChange={(event) =>
                    void saveVoiceLines({
                      probability: Number(event.target.value)
                    })
                  }
                />
                <strong>{voiceLines.probability}%</strong>
              </label>
              <div className="voice-line-list">
                {voiceLines.clips.map((clip) => (
                  <div className="voice-line-row" key={clip.id}>
                    <span title={clip.name}>{clip.name}</span>
                    <button
                      type="button"
                      onClick={() => previewVoiceLine(clip)}
                    >
                      播放
                    </button>
                    <button
                      type="button"
                      title="删除这段语音"
                      onClick={() =>
                        void window.deskPet
                          .removeVoiceLine(pet.id, clip.id)
                          .then(() => refresh())
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                {voiceLines.clips.length === 0 && (
                  <p className="empty-copy">还没有导入角色语音。</p>
                )}
              </div>
              <button
                className="wide-secondary"
                type="button"
                onClick={() => void importVoiceLines()}
              >
                <Upload size={16} />
                导入 WAV 语音
              </button>
              {voiceLineAudioUrl && (
                <audio
                  src={voiceLineAudioUrl}
                  autoPlay
                  onEnded={() => setVoiceLineAudioUrl("")}
                />
              )}
            </div>
              <div className="auto-dialogue-panel">
                <div>
                  <span className="section-kicker">AI 自动输出</span>
                  <strong>{pet.name} 的自主行为</strong>
                  <p>
                    两个开关互相独立。关闭自动文字后，随机角色语音仍然可以播放；右键手动对话不受影响。
                  </p>
                </div>
                <div className="auto-dialogue-row">
                  <div>
                    <strong>自动文字</strong>
                    <span>让 AI 主动生成文字对话</span>
                  </div>
                  <button
                    className={
                      autoTextEnabled
                        ? "auto-dialogue-button auto-dialogue-button--on"
                        : "auto-dialogue-button auto-dialogue-button--off"
                    }
                    type="button"
                    onClick={() =>
                      void updateState({
                        pets: state.pets.map((item) =>
                          item.id === pet.id
                            ? { ...item, autoTextEnabled: !autoTextEnabled }
                            : item
                        )
                      })
                    }
                  >
                    {autoTextEnabled ? <Bot size={14} /> : <X size={14} />}
                    {autoTextEnabled ? "已开启" : "已关闭"}
                  </button>
                </div>
                <div className="auto-dialogue-row">
                  <div>
                    <strong>自动语音</strong>
                    <span>控制 AI 语音与随机角色语音</span>
                  </div>
                  <button
                    className={
                      autoVoiceEnabled
                        ? "auto-dialogue-button auto-dialogue-button--on"
                        : "auto-dialogue-button auto-dialogue-button--off"
                    }
                    type="button"
                    onClick={() =>
                      void updateState({
                        pets: state.pets.map((item) =>
                          item.id === pet.id
                            ? { ...item, autoVoiceEnabled: !autoVoiceEnabled }
                            : item
                        )
                      })
                    }
                  >
                    {autoVoiceEnabled ? <Volume2 size={14} /> : <X size={14} />}
                    {autoVoiceEnabled ? "已开启" : "已关闭"}
                  </button>
                </div>
              </div>
          </>
        ) : (
          <p className="empty-copy">当前角色还没有可编辑的动作。</p>
        )}
      </aside>

      {false && showAdvanced && mode === "edit" && (
        <div className="advanced-settings-backdrop">
          <section className="advanced-settings-dialog">
            <div className="advanced-settings-header">
              <div>
                <span className="section-kicker">高级设置</span>
                <h2>{pet.name}</h2>
              </div>
              <button type="button" onClick={() => setShowAdvanced(false)}>
                关闭
              </button>
            </div>

            <div className="advanced-settings-grid">
              <label className="range-field">
                <span>显示宽度</span>
                <input
                  type="range"
                  min="160"
                  max="800"
                  step="10"
                  value={pet.renderConfig?.displayWidth || 260}
                  onChange={(event) =>
                    saveRenderConfig({
                      displayWidth: Number(event.target.value)
                    })
                  }
                />
                <strong>{pet.renderConfig?.displayWidth || 260}</strong>
              </label>
              <label className="range-field">
                <span>显示高度</span>
                <input
                  type="range"
                  min="180"
                  max="900"
                  step="10"
                  value={pet.renderConfig?.displayHeight || 320}
                  onChange={(event) =>
                    saveRenderConfig({
                      displayHeight: Number(event.target.value)
                    })
                  }
                />
                <strong>{pet.renderConfig?.displayHeight || 320}</strong>
              </label>
              <label className="range-field">
                <span>碰撞宽度</span>
                <input
                  type="range"
                  min="40"
                  max="300"
                  step="2"
                  value={pet.renderConfig?.hitboxWidth || 104}
                  onChange={(event) =>
                    saveRenderConfig({
                      hitboxWidth: Number(event.target.value)
                    })
                  }
                />
                <strong>{pet.renderConfig?.hitboxWidth || 104}</strong>
              </label>
              <label className="range-field">
                <span>碰撞高度</span>
                <input
                  type="range"
                  min="60"
                  max="420"
                  step="2"
                  value={pet.renderConfig?.hitboxHeight || 134}
                  onChange={(event) =>
                    saveRenderConfig({
                      hitboxHeight: Number(event.target.value)
                    })
                  }
                />
                <strong>{pet.renderConfig?.hitboxHeight || 134}</strong>
              </label>
              <label className="range-field">
                <span>水平偏移</span>
                <input
                  type="range"
                  min="-200"
                  max="200"
                  step="2"
                  value={pet.renderConfig?.offsetX || 0}
                  onChange={(event) => {
                    const offsetX = Number(event.target.value);
                    const currentOffsetX = pet.renderConfig?.offsetX || 0;
                    saveRenderConfig({
                      offsetX,
                      hitboxOffsetX: Math.round(
                        (pet.renderConfig?.hitboxOffsetX || 0) +
                          offsetX -
                          currentOffsetX
                      )
                    });
                  }}
                />
                <strong>{pet.renderConfig?.offsetX || 0}</strong>
              </label>
              <label className="range-field">
                <span>垂直偏移</span>
                <input
                  type="range"
                  min="-200"
                  max="200"
                  step="2"
                  value={pet.renderConfig?.offsetY || 0}
                  onChange={(event) => {
                    const offsetY = Number(event.target.value);
                    const currentOffsetY = pet.renderConfig?.offsetY || 0;
                    saveRenderConfig({
                      offsetY,
                      hitboxOffsetY: Math.round(
                        (pet.renderConfig?.hitboxOffsetY || 0) +
                          offsetY -
                          currentOffsetY
                      )
                    });
                  }}
                />
                <strong>{pet.renderConfig?.offsetY || 0}</strong>
              </label>
            </div>

            <div className="advanced-settings-actions">
              <button
                type="button"
                onClick={() =>
                  saveRenderConfig({
                    displayWidth: 900,
                    displayHeight: 760,
                    hitboxWidth: 104,
                    hitboxHeight: 134,
                    offsetX: 0,
                    offsetY: 0,
                    hitboxOffsetX: 0,
                    hitboxOffsetY: 0
                  })
                }
              >
                自动检测并恢复推荐值
              </button>
              <button
                className="advanced-future-button"
                type="button"
                disabled
                title="后续用于上传整张立绘并自动抠图"
              >
                创建平面图片角色（预留）
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
