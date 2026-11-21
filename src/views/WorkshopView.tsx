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
  anchorLayoutPlacement,
  getLayoutBoxPosition,
  isPetLayoutV3,
  resolvePetLayout,
  withRenderConfigDefaults
} from "../lib/renderConfig";
import { useAppState } from "../state";
import { useConfirm } from "../components/ConfirmDialog";
import type {
  BoneRoleMap,
  PetDesktopLayout,
  PetLayoutBox,
  PetModulePlugins,
  PetProfile,
  PetRenderConfig,
  PetVoiceClip,
  PetVoiceLines,
  SpinePartKind,
  SpineStagedPart
} from "../types";

type WorkshopMode = "edit" | "create";
type AdvancedBoxMode = "collision" | "interaction";
type AdvancedMode = "display" | AdvancedBoxMode;
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

function hasSameLayout(
  left: PetDesktopLayout | null,
  right: PetDesktopLayout | null
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function withUpdatedLayoutBox(
  layout: PetDesktopLayout,
  mode: AdvancedBoxMode,
  box: PetLayoutBox
) {
  const next: PetDesktopLayout = {
    ...layout,
    [mode]: box
  };
  return anchorLayoutPlacement(layout, next);
}

export const ADVANCED_DRAFT_STORAGE_PREFIX =
  "arkpet:advanced-render-draft:v1:";

function getAdvancedDraftStorageKey(petId: string) {
  return `${ADVANCED_DRAFT_STORAGE_PREFIX}${petId}`;
}

function readAdvancedLayoutDraft(petId: string): PetDesktopLayout | null {
  try {
    const raw = window.sessionStorage.getItem(getAdvancedDraftStorageKey(petId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PetDesktopLayout> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return isPetLayoutV3(parsed) ? resolvePetLayout(parsed) : null;
  } catch {
    return null;
  }
}

function writeAdvancedLayoutDraft(petId: string, draft: PetDesktopLayout) {
  try {
    window.sessionStorage.setItem(
      getAdvancedDraftStorageKey(petId),
      JSON.stringify(draft)
    );
  } catch {
    // Session storage can be unavailable in restricted renderer contexts.
  }
}

function clearAdvancedLayoutDraft(petId: string) {
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
  const { confirm } = useConfirm();
  const [mode, setMode] = useState<WorkshopMode>("edit");
  const [draftId, setDraftId] = useState(() => makeId("spine-draft"));
  const [petNameError, setPetNameError] = useState("");
  const [draftParts, setDraftParts] = useState<
    Partial<Record<SpinePartKind, SpineStagedPart>>
  >({});
  const [creating, setCreating] = useState(false);
  const [previewAction, setPreviewAction] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advancedMode, setAdvancedMode] =
    useState<AdvancedMode>("collision");
  const [draftLayout, setDraftLayout] = useState<PetDesktopLayout | null>(null);
  const [layoutDirty, setLayoutDirty] = useState(false);
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
    draft: PetDesktopLayout;
  } | null>(null);

  const currentPetForDraft = state
    ? state.pets.find((item) => item.id === state.activePetId) || state.pets[0]
    : null;
  draftPersistenceRef.current =
    currentPetForDraft &&
    draftOwnerPetIdRef.current === currentPetForDraft.id &&
    draftLayout &&
    layoutDirty
      ? { petId: currentPetForDraft.id, draft: draftLayout }
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
    restoreAdvancedLayoutDraft(
      currentPet.id,
      currentPet.layout,
      currentPet.renderConfig,
      currentPet.desktopPosition
    );
  }, [state?.activePetId]);

  useEffect(() => {
    if (showAdvanced) return;
    advancedPointerCleanupRef.current?.();
  }, [showAdvanced]);

  useEffect(() => {
    const pendingDraft = draftPersistenceRef.current;
    if (!pendingDraft) return;
    writeAdvancedLayoutDraft(pendingDraft.petId, pendingDraft.draft);
  }, [draftLayout, layoutDirty, state?.activePetId]);

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
        writeAdvancedLayoutDraft(pendingDraft.petId, pendingDraft.draft);
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
    withRenderConfigDefaults(pet.renderConfig);
  const activeLayout: PetDesktopLayout =
    draftLayout ||
    resolvePetLayout(pet.layout, pet.renderConfig, pet.desktopPosition);
  const hasV3Layout = isPetLayoutV3(pet.layout);

  function restoreAdvancedLayoutDraft(
    petId: string,
    savedLayout?: Partial<PetDesktopLayout> | null,
    savedConfig?: Partial<PetRenderConfig> | null,
    desktopPosition?: PetProfile["desktopPosition"]
  ) {
    const restoredDraft = readAdvancedLayoutDraft(petId);
    const nextLayout =
      restoredDraft ||
      resolvePetLayout(savedLayout, savedConfig, desktopPosition);
    draftOwnerPetIdRef.current = petId;
    setDraftLayout(nextLayout);
    setAdvancedPreviewBaseScaleLock(getAdvancedPreviewScale(nextLayout));
    setLayoutDirty(restoredDraft !== null);
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
    if (
      !(await confirm(`确定删除“${pet.name}”吗？素材仍会保留在数据目录中。`, {
        danger: true,
        title: "删除角色"
      }))
    ) {
      return;
    }
    const pets = currentState.pets.filter((item) => item.id !== pet.id);
    await updateState({ pets, activePetId: pets[0].id });
    clearAdvancedLayoutDraft(pet.id);
    setMode("edit");
  }

  async function startCreate() {
    if (!(await resolveUnsavedRenderConfig())) return;
    clearAdvancedLayoutDraft(pet.id);
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

  function updateActiveLayout(
    transform: (current: PetDesktopLayout) => PetDesktopLayout
  ) {
    draftOwnerPetIdRef.current = pet.id;
    setDraftLayout((current) => transform(current || activeLayout));
    setLayoutDirty(true);
  }

  function updateLayoutBox(
    mode: AdvancedBoxMode,
    patch: Partial<PetLayoutBox>
  ) {
    updateActiveLayout((current) => {
      const nextBox = {
        ...current[mode],
        ...patch
      };
      const next = withUpdatedLayoutBox(current, mode, nextBox);
      if (mode !== "collision") return next;
      // 碰撞框偏移与显示框偏移互为相反数（placement = 碰撞框中心）。
      return {
        ...next,
        displayFrame: {
          ...next.displayFrame,
          offsetX: -next.collision.offsetX,
          offsetY: -next.collision.offsetY
        }
      };
    });
  }

  function updateDisplayFrame(
    patch: Partial<PetDesktopLayout["displayFrame"]>
  ) {
    updateActiveLayout((current) => {
      const nextFrame = {
        ...current.displayFrame,
        ...patch
      };
      const next = {
        ...current,
        displayFrame: nextFrame
      };
      if (!("offsetX" in patch) && !("offsetY" in patch)) return next;
      // 显示框偏移变化时同步碰撞框偏移（互为相反数）。
      return {
        ...next,
        collision: {
          ...next.collision,
          offsetX: -(nextFrame.offsetX ?? 0),
          offsetY: -(nextFrame.offsetY ?? 0)
        }
      };
    });
  }

  async function commitRenderConfig() {
    const nextLayout = activeLayout;
    if (hasV3Layout) {
      await savePet({
        ...pet,
        layout: nextLayout
      });
    } else {
      // 旧记录保留 legacy 运行路径，同时补写 v3 布局供后续版本读取。
      const nextRenderConfig = withRenderConfigDefaults({
        ...(pet.renderConfig || {}),
        displayWidth: nextLayout.displayFrame.width,
        displayHeight: nextLayout.displayFrame.height,
        hitboxWidth: nextLayout.collision.width,
        hitboxHeight: nextLayout.collision.height
      });
      await savePet({
        ...pet,
        renderConfig: nextRenderConfig,
        desktopRenderConfig: nextRenderConfig,
        layout: nextLayout
      });
    }
    draftOwnerPetIdRef.current = pet.id;
    setDraftLayout(nextLayout);
    setLayoutDirty(false);
    clearAdvancedLayoutDraft(pet.id);
  }

  async function resolveUnsavedRenderConfig() {
    if (!layoutDirty) return true;
    const shouldSave = await confirm(
      "高级设置有未保存的改动。\n\n点击“确定”保存并继续；点击“取消”后再选择是否放弃。",
      { title: "保存高级设置" }
    );
    if (shouldSave) {
      await commitRenderConfig();
      return true;
    }
    const shouldDiscard = await confirm(
      "是否放弃本次高级设置改动？\n\n点击“确定”放弃；点击“取消”留在当前角色继续编辑。",
      { danger: true, title: "放弃改动" }
    );
    if (!shouldDiscard) return false;
    draftOwnerPetIdRef.current = pet.id;
    setDraftLayout(
      resolvePetLayout(pet.layout, pet.renderConfig, pet.desktopPosition)
    );
    setLayoutDirty(false);
    clearAdvancedLayoutDraft(pet.id);
    return true;
  }

  async function toggleAdvancedSettings() {
    if (!showAdvanced) {
      restoreAdvancedLayoutDraft(
        pet.id,
        pet.layout,
        pet.renderConfig,
        pet.desktopPosition
      );
      setShowAdvanced(true);
      return;
    }
    if (!(await resolveUnsavedRenderConfig())) return;
    clearAdvancedLayoutDraft(pet.id);
    setShowAdvanced(false);
  }

  function getAdvancedPreviewScale(layout: PetDesktopLayout) {
    const width = layout.displayFrame.width;
    const height = layout.displayFrame.height;
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
    getLayout: (
      dx: number,
      dy: number,
      start: PetDesktopLayout
    ) => PetDesktopLayout,
    lockPreviewBase = false
  ) {
    event.preventDefault();
    event.stopPropagation();
    advancedPointerCleanupRef.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    const captureTarget = event.currentTarget as HTMLElement;
    const pointerId = event.pointerId;
    const startDraft = activeLayout;
    const savedDraft = resolvePetLayout(
      pet.layout,
      pet.renderConfig,
      pet.desktopPosition
    );
    draftOwnerPetIdRef.current = pet.id;
    const lockedPreviewBase = lockPreviewBase
      ? advancedPreviewBaseScaleLock ?? getAdvancedPreviewScale(startDraft)
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

    const applyPendingPoint = () => {
      frame = null;
      if (!pendingPoint) return;
      const dx = (pendingPoint.x - startX) / previewScale;
      const dy = (pendingPoint.y - startY) / previewScale;
      pendingPoint = null;
      setDraftLayout(getLayout(dx, dy, startDraft));
      setLayoutDirty(true);
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
      if (advancedPointerCleanupRef.current === detach) {
        advancedPointerCleanupRef.current = null;
      }
    };

    const cancel = () => {
      detach();
      setDraftLayout(startDraft);
      setLayoutDirty(!hasSameLayout(startDraft, savedDraft));
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
    mode: AdvancedBoxMode
  ) {
    beginAdvancedPointerSession(event, (dx, dy, start) => {
      const box = start[mode];
      return withUpdatedLayoutBox(start, mode, {
        ...box,
        offsetX: Math.round(
          box.offsetX + dx * start.placement.direction
        ),
        offsetY: Math.round(box.offsetY + dy)
      });
    });
  }

  // 拖动显示框本身：只改显示框相对碰撞框中心（placement）的偏移。
  // 碰撞框偏移与显示框偏移互为相反数，保持“placement = 碰撞框中心”不变；
  // 交互框偏移相对显示框中心，因此随显示框一起移动。
  function beginAdvancedDisplayDrag(event: React.PointerEvent) {
    beginAdvancedPointerSession(event, (dx, dy, start) => {
      const direction = start.placement.direction;
      const offsetX = Math.round(
        (start.displayFrame.offsetX ?? -start.collision.offsetX) +
          dx * direction
      );
      const offsetY = Math.round(
        (start.displayFrame.offsetY ?? -start.collision.offsetY) + dy
      );
      return {
        ...start,
        displayFrame: {
          ...start.displayFrame,
          offsetX,
          offsetY
        },
        collision: {
          ...start.collision,
          offsetX: -offsetX,
          offsetY: -offsetY
        }
      };
    });
  }

  function beginAdvancedResize(
    event: React.PointerEvent,
    mode: "display" | AdvancedMode,
    edge: AdvancedResizeEdge
  ) {
    const handlesLeft = edge.includes("w");
    const handlesRight = edge.includes("e");
    const handlesTop = edge.includes("n");
    const handlesBottom = edge.includes("s");

    beginAdvancedPointerSession(event, (rawDx, rawDy, start) => {
      const dx = Math.round(rawDx);
      const dy = Math.round(rawDy);
      const widthDelta = (handlesRight ? dx : 0) - (handlesLeft ? dx : 0);
      const heightDelta = (handlesBottom ? dy : 0) - (handlesTop ? dy : 0);

      if (mode === "display") {
        return {
          ...start,
          displayFrame: {
            ...start.displayFrame,
            width: Math.max(
              40,
              Math.round(start.displayFrame.width + widthDelta)
            ),
            height: Math.max(
              60,
              Math.round(start.displayFrame.height + heightDelta)
            )
          }
        };
      }
      const box = start[mode];
      const width = Math.max(20, Math.round(box.width + widthDelta));
      const height = Math.max(30, Math.round(box.height + heightDelta));
      const actualWidthDelta = width - box.width;
      const actualHeightDelta = height - box.height;
      const horizontalCenterDelta =
        (handlesLeft
          ? -actualWidthDelta / 2
          : handlesRight
            ? actualWidthDelta / 2
            : 0) * start.placement.direction;
      return withUpdatedLayoutBox(start, mode, {
        width,
        height,
        offsetX: Math.round(box.offsetX + horizontalCenterDelta),
        offsetY: handlesTop
          ? Math.round(box.offsetY - actualHeightDelta / 2)
          : handlesBottom
            ? Math.round(box.offsetY + actualHeightDelta / 2)
            : box.offsetY
      });
    }, mode === "display");
  }

  const canCreate =
    Boolean(draftParts.skeleton) &&
    Boolean(draftParts.atlas) &&
    Boolean(draftParts.texture) &&
    draftDiagnostics?.status !== "invalid";
  // 预览倍率只改变查看比例，保存的 geometry 始终使用归一化基础值。
  const advancedPreviewBaseScale =
    advancedPreviewBaseScaleLock ?? getAdvancedPreviewScale(activeLayout);
  const advancedScale = advancedPreviewBaseScale * advancedPreviewZoom;
  const advancedDisplayWidth =
    activeLayout.displayFrame.width * advancedScale;
  const advancedDisplayHeight =
    activeLayout.displayFrame.height * advancedScale;
  const advancedVisualWidth =
    (activeRenderConfig.visualWidth || 104) * advancedScale;
  const advancedVisualHeight =
    (activeRenderConfig.visualHeight || 134) * advancedScale;
  const advancedCenterX = stageSize.width / 2;
  const advancedCenterY = stageSize.height / 2;
  // 舞台中心 = 碰撞框中心（placement）。显示框中心按 displayFrame.offset 相对它偏移
  // （X 随朝向镜像），缺省时回退到 -collision.offset（旧语义）。
  const advancedDisplayOffsetX =
    (activeLayout.displayFrame.offsetX ?? -activeLayout.collision.offsetX) *
    (activeLayout.placement.direction === -1 ? -1 : 1) *
    advancedScale;
  const advancedDisplayOffsetY =
    (activeLayout.displayFrame.offsetY ?? -activeLayout.collision.offsetY) *
    advancedScale;
  const advancedDisplayLeft =
    advancedCenterX + advancedDisplayOffsetX - advancedDisplayWidth / 2;
  const advancedDisplayTop =
    advancedCenterY + advancedDisplayOffsetY - advancedDisplayHeight / 2;
  // 显示模式下作为参照的碰撞框（不可交互）。
  const advancedCollisionWidth =
    activeLayout.collision.width * advancedScale;
  const advancedCollisionHeight =
    activeLayout.collision.height * advancedScale;
  const advancedCollisionPosition = getLayoutBoxPosition(
    {
      width: advancedDisplayWidth,
      height: advancedDisplayHeight
    },
    {
      width: advancedCollisionWidth,
      height: advancedCollisionHeight,
      offsetX: activeLayout.collision.offsetX,
      offsetY: activeLayout.collision.offsetY
    },
    activeLayout.placement.direction
  );
  const activeLayoutBox =
    advancedMode === "interaction"
      ? activeLayout.interaction
      : activeLayout.collision;
  const advancedVolumeWidth = activeLayoutBox.width * advancedScale;
  const advancedVolumeHeight = activeLayoutBox.height * advancedScale;
  const advancedVolumePosition = getLayoutBoxPosition(
    {
      width: advancedDisplayWidth,
      height: advancedDisplayHeight
    },
    {
      width: advancedVolumeWidth,
      height: advancedVolumeHeight,
      offsetX: activeLayoutBox.offsetX * advancedScale,
      offsetY: activeLayoutBox.offsetY * advancedScale
    },
    activeLayout.placement.direction
  );

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
                clearAdvancedLayoutDraft(pet.id);
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
                onClick={deletePet}
                disabled={state.pets.length <= 1}
              >
                <Trash2 size={16} />
                删除
              </button>
              <button
                className="primary-small"
                type="button"
                onClick={() =>
                  layoutDirty ? commitRenderConfig() : savePet(pet)
                }
              >
                <Save size={16} />
                保存
              </button>
              <button
                className="advanced-settings-button"
                type="button"
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
            <div
              className="workshop-spine-wrap"
              style={
                showAdvanced
                  ? {
                      transform: `translate(${advancedDisplayOffsetX}px, ${advancedDisplayOffsetY}px)`
                    }
                  : undefined
              }
            >
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
                  ? (pet.desktopRenderConfig || pet.renderConfig)?.offsetX
                  : -28 + activeRenderConfig.offsetX
              }
              offsetY={
                showAdvanced
                  ? (pet.desktopRenderConfig || pet.renderConfig)?.offsetY
                  : activeRenderConfig.offsetY
              }
              anchorBottom={showAdvanced}
              normalizeBodySize={showAdvanced}
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
            </div>
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
              <div className="advanced-stage-label">角色中心已锁定</div>
              {advancedMode === "display" ? (
                <>
                  <div
                    className="advanced-volume-frame advanced-volume-frame--collision"
                    style={{
                      left:
                        advancedDisplayLeft +
                        advancedCollisionPosition.left,
                      top:
                        advancedDisplayTop +
                        advancedCollisionPosition.top,
                      width: advancedCollisionWidth,
                      height: advancedCollisionHeight,
                      pointerEvents: "none",
                      opacity: 0.55
                    }}
                  >
                    <span className="advanced-frame-label">
                      碰撞体积（参照）
                    </span>
                  </div>
                  <div
                    className="advanced-display-frame advanced-display-frame--fixed"
                    style={{
                      left: advancedDisplayLeft,
                      top: advancedDisplayTop,
                      width: advancedDisplayWidth,
                      height: advancedDisplayHeight,
                      pointerEvents: "auto",
                      cursor: "move"
                    }}
                    onPointerDown={beginAdvancedDisplayDrag}
                  >
                    <span className="advanced-frame-label">显示框</span>
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
                </>
              ) : (
                <div
                  className={`advanced-volume-frame advanced-volume-frame--${advancedMode}`}
                  style={{
                    left: advancedDisplayLeft + advancedVolumePosition.left,
                    top: advancedDisplayTop + advancedVolumePosition.top,
                    width: advancedVolumeWidth,
                    height: advancedVolumeHeight
                  }}
                  onPointerDown={(event) =>
                    beginAdvancedDrag(event, advancedMode)
                  }
                >
                  <span className="advanced-frame-label">
                    {advancedMode === "collision" ? "碰撞体积" : "交互范围"}
                  </span>
                  {advancedResizeEdges.map((edge) => (
                    <span
                      className={`advanced-resize-edge advanced-resize-edge--${edge}`}
                      key={edge}
                      onPointerDown={(event) =>
                        beginAdvancedResize(event, advancedMode, edge)
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
                      advancedMode === "display"
                        ? "advanced-mode-button advanced-mode-button--active"
                        : "advanced-mode-button"
                    }
                    type="button"
                    onClick={() => setAdvancedMode("display")}
                  >
                    编辑显示框
                  </button>
                  <button
                    className={
                      advancedMode === "collision"
                        ? "advanced-mode-button advanced-mode-button--active"
                        : "advanced-mode-button"
                    }
                    type="button"
                    onClick={() => setAdvancedMode("collision")}
                  >
                    编辑碰撞体积
                  </button>
                  <button
                    className={
                      advancedMode === "interaction"
                        ? "advanced-mode-button advanced-mode-button--active"
                        : "advanced-mode-button"
                    }
                    type="button"
                    onClick={() => setAdvancedMode("interaction")}
                  >
                    编辑交互范围
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
                {advancedMode === "display" ? (
                  <div className="advanced-section">
                    <div className="advanced-section-heading">
                      <strong>显示框</strong>
                      <span>中心固定，仅调整尺寸</span>
                    </div>
                    <div className="advanced-number-grid advanced-number-grid--single">
                      <label className="advanced-number-field">
                        <span>宽度</span>
                        <input
                          type="number"
                          min="40"
                          max="4000"
                          step="1"
                          value={activeLayout.displayFrame.width}
                          onFocus={(event) => event.currentTarget.select()}
                          onChange={(event) => {
                            const value = Number(event.target.value);
                            if (!Number.isFinite(value)) return;
                            updateDisplayFrame({
                              width: Math.max(40, Math.round(value))
                            });
                          }}
                        />
                        <em>px</em>
                      </label>
                      <label className="advanced-number-field">
                        <span>高度</span>
                        <input
                          type="number"
                          min="60"
                          max="4000"
                          step="1"
                          value={activeLayout.displayFrame.height}
                          onFocus={(event) => event.currentTarget.select()}
                          onChange={(event) => {
                            const value = Number(event.target.value);
                            if (!Number.isFinite(value)) return;
                            updateDisplayFrame({
                              height: Math.max(60, Math.round(value))
                            });
                          }}
                        />
                        <em>px</em>
                      </label>
                    </div>
                  </div>
                ) : (
                  <div className="advanced-section">
                    <div className="advanced-section-heading">
                      <strong>
                        {advancedMode === "collision"
                          ? "碰撞体积"
                          : "交互范围"}
                      </strong>
                      <span>归一化像素</span>
                    </div>
                    <div className="advanced-number-grid">
                      <label className="advanced-number-field">
                        <span>宽度</span>
                        <input
                          type="number"
                          min="20"
                          max="4000"
                          step="1"
                          value={activeLayoutBox.width}
                          onFocus={(event) => event.currentTarget.select()}
                          onChange={(event) => {
                            const value = Number(event.target.value);
                            if (!Number.isFinite(value)) return;
                            updateLayoutBox(advancedMode, {
                              width: Math.max(20, Math.round(value))
                            });
                          }}
                        />
                        <em>px</em>
                      </label>
                      <label className="advanced-number-field">
                        <span>高度</span>
                        <input
                          type="number"
                          min="30"
                          max="4000"
                          step="1"
                          value={activeLayoutBox.height}
                          onFocus={(event) => event.currentTarget.select()}
                          onChange={(event) => {
                            const value = Number(event.target.value);
                            if (!Number.isFinite(value)) return;
                            updateLayoutBox(advancedMode, {
                              height: Math.max(30, Math.round(value))
                            });
                          }}
                        />
                        <em>px</em>
                      </label>
                      <label className="advanced-number-field">
                        <span>水平偏移</span>
                        <input
                          type="number"
                          min="-4000"
                          max="4000"
                          step="1"
                          value={activeLayoutBox.offsetX}
                          onFocus={(event) => event.currentTarget.select()}
                          onChange={(event) => {
                            const value = Number(event.target.value);
                            if (!Number.isFinite(value)) return;
                            updateLayoutBox(advancedMode, {
                              offsetX: Math.round(value)
                            });
                          }}
                        />
                        <em>px</em>
                      </label>
                      <label className="advanced-number-field">
                        <span>垂直偏移</span>
                        <input
                          type="number"
                          min="-4000"
                          max="4000"
                          step="1"
                          value={activeLayoutBox.offsetY}
                          onFocus={(event) => event.currentTarget.select()}
                          onChange={(event) => {
                            const value = Number(event.target.value);
                            if (!Number.isFinite(value)) return;
                            updateLayoutBox(advancedMode, {
                              offsetY: Math.round(value)
                            });
                          }}
                        />
                        <em>px</em>
                      </label>
                    </div>
                  </div>
                )}
                <div className="advanced-save-row">
                  <button
                    className="advanced-save-button"
                    type="button"
                    disabled={!layoutDirty}
                    onClick={() => void commitRenderConfig()}
                  >
                    保存高级设置
                  </button>
                  <span>
                    {layoutDirty
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
                </div>
                <div className="auto-dialogue-row">
                  <div>
                    <strong>自动文字</strong>
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

    </div>
  );
}
