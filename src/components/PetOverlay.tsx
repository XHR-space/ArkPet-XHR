import { MessageCircle, Mic, Moon, Power, Puzzle, Send, X } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent
} from "react";
import { createPortal } from "react-dom";
import { clamp } from "../lib/format";
import { makeId } from "../lib/id";
import { getHitboxPosition, getVisualSize } from "../lib/renderConfig";
import { chooseBoundAnimation } from "../lib/spineActions";
import { resolveDialogModule } from "../lib/dialogModules";
import { decayModuleMetrics, readModuleMetric } from "../lib/moduleMetrics";
import {
  advancePetVitals,
  AUTO_RECALL_ZERO_ENERGY_MS,
  ensurePetVitals
} from "../lib/petVitals";
import { recordPhysicalInteraction } from "../lib/wellbeing";
import type {
  AppSettings,
  AppState,
  DisplayMetrics,
  PetInputPayload,
  PetInteractionRegion,
  PetProfile
} from "../types";
import { PetAvatar } from "./PetAvatar";
import { SpinePet } from "./SpinePet";

type EntitySnapshot = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  hitboxOffsetX: number;
  hitboxOffsetY: number;
  vx: number;
  vy: number;
  direction: 1 | -1;
  directionY: 1 | -1;
  passUntil: number;
  zIndex: number;
  menu?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

type PhysicsState = EntitySnapshot & {
  dragging: boolean;
  grounded: boolean;
  visualOffsetX: number;
  visualOffsetY: number;
  dragOffsetX: number;
  dragOffsetY: number;
  lastPointerX: number;
  lastPointerY: number;
  lastPointerAt: number;
  nextIdleAt: number;
  nextJumpAt: number;
  idleUntil: number;
  restingUntil: number;
  thrown: boolean;
  supportY: number | null;
  supportLeft: number | null;
  supportRight: number | null;
  supportId: string | null;
  supportGraceUntil: number;
  nextDirectionAt: number;
  pendingJumpAt: number;
  pendingJumpVx: number;
  pendingJumpVy: number;
  fallbackRequested: boolean;
};

type DragSession = {
  pointerId: number;
  captureElement: HTMLDivElement;
  globalMode: boolean;
  localListenersAttached: boolean;
  pointerMove: (event: PointerEvent) => void;
  mouseMove: (event: MouseEvent) => void;
  pointerUp: (event: PointerEvent) => void;
  pointerCancel: (event: PointerEvent) => void;
  pointerLeave: (event: PointerEvent) => void;
};

type DragMoveSource = "pointer" | "mouse" | "global";

type DesktopIconRect = {
  id?: string;
  petId?: string;
  name: string;
  foodPath: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type EntityProps = {
  pet: PetProfile;
  overlaySettings: AppSettings["overlay"];
  metrics: DisplayMetrics;
  registry: MutableRefObject<Map<string, EntitySnapshot>>;
  canInteract: boolean;
  dialogModule?: AppState["customModules"][number];
  customModules: AppState["customModules"];
  voiceProfiles: AppState["voiceProfiles"];
  desktopIcons: DesktopIconRect[];
  iconSteps: { x: number; y: number };
  onClimbPlatform: (platform: DesktopIconRect) => void;
  onFoodConsumed: (foodPath: string) => void;
  onDragInteract: () => void;
  foodNotice?: string;
};

const BASE_WIDTH = 104;
const BASE_HEIGHT = 134;
const DRAG_VISUAL_DELAY_MS = 340;

function nextAutoTalkDelayMs(initiative: number) {
  const normalized = clamp(Number(initiative || 0), 0, 100) / 100;
  const base = 300000 - normalized * 120000;
  return base + Math.random() * 120000;
}

function isMeaningfulDialogueText(value: string) {
  return value.replace(
    /[\s，。！？、；：,.!?;:…"'“”‘’—\-（）()【】\[\]《》<>/\\|]+/g,
    ""
  ).length > 0;
}

let overlayMouseIgnoreState: boolean | null = null;
let overlayDragging = false;
const autoRecallPending = new Set<string>();
const globalAutoTalkGate = { busy: false, cooldownUntil: 0 };

type PanelClaim = {
  petId: string;
  mouse: boolean;
  focus: boolean;
  suppressPetInput: boolean;
};

type PanelPosition = {
  left: number;
  top: number;
};

const panelClaims = new Map<string, PanelClaim>();
const suppressedPanelClaims = new Map<string, number>();
const menuOwnerSubscribers = new Set<(petId: string) => void>();
let activeMenuOwner = "";
let panelZCounter = 1000;

function nextPanelZIndex() {
  panelZCounter += 1;
  return panelZCounter;
}

function syncPanelClaims() {
  const focusable = Array.from(panelClaims.values()).some(
    (claim) => claim.focus
  );
  const ignoreMouse = !Array.from(panelClaims.values()).some(
    (claim) => claim.mouse
  );
  window.deskPet.setOverlayFocusable(focusable);
  overlayMouseIgnoreState = null;
  applyOverlayMouseIgnore(ignoreMouse);
}

function setSuppressedPanelPet(petId: string, suppressed: boolean) {
  const current = suppressedPanelClaims.get(petId) || 0;
  const next = Math.max(0, current + (suppressed ? 1 : -1));
  if (next === 0) suppressedPanelClaims.delete(petId);
  else suppressedPanelClaims.set(petId, next);

  const setter = (
    window.deskPet as typeof window.deskPet & {
      setPetInputSuppressed?: (id: string, value: boolean) => void;
    }
  ).setPetInputSuppressed;
  if (typeof setter === "function") {
    setter(petId, next > 0);
  }
}

function claimPanel(token: string, claim: PanelClaim) {
  if (panelClaims.has(token)) return;
  panelClaims.set(token, claim);
  if (claim.suppressPetInput) setSuppressedPanelPet(claim.petId, true);
  syncPanelClaims();
}

function releasePanel(token: string) {
  const claim = panelClaims.get(token);
  if (!claim) return;
  panelClaims.delete(token);
  if (claim.suppressPetInput) setSuppressedPanelPet(claim.petId, false);
  syncPanelClaims();
}

function publishMenuOwner(petId: string) {
  activeMenuOwner = petId;
  for (const subscriber of Array.from(menuOwnerSubscribers)) {
    subscriber(petId);
  }
}

function clearMenuOwner(petId: string) {
  if (activeMenuOwner !== petId) return;
  activeMenuOwner = "";
  for (const subscriber of Array.from(menuOwnerSubscribers)) {
    subscriber("");
  }
}

function subscribeMenuOwner(callback: (petId: string) => void) {
  menuOwnerSubscribers.add(callback);
  return () => menuOwnerSubscribers.delete(callback);
}

function clampPanelPosition(
  left: number,
  top: number,
  width: number,
  height: number
): PanelPosition {
  return {
    left: clamp(left, 8, Math.max(8, window.innerWidth - width - 8)),
    top: clamp(top, 8, Math.max(8, window.innerHeight - height - 8))
  };
}

function positionAboveDisplay(
  entity: Pick<EntitySnapshot, "x" | "y" | "width">,
  width: number,
  height: number
) {
  return clampPanelPosition(
    entity.x + entity.width / 2 - width / 2,
    entity.y - height - 12,
    width,
    height
  );
}

function positionBesideDisplay(
  entity: Pick<EntitySnapshot, "x" | "y" | "width" | "height">,
  width: number,
  height: number
) {
  const right = entity.x + entity.width + 10;
  const left = entity.x - width - 10;
  const preferredLeft =
    right + width <= window.innerWidth - 8 ? right : left;
  return clampPanelPosition(
    preferredLeft,
    entity.y + entity.height / 2 - height / 2,
    width,
    height
  );
}

function applyOverlayMouseIgnore(ignore: boolean) {
  if (overlayMouseIgnoreState === ignore) return;
  overlayMouseIgnoreState = ignore;
  window.deskPet.setOverlayMouseIgnore(ignore);
}

function isPetInputDown(type: PetInputPayload["type"]) {
  return type === "down" || type === "pointerdown";
}

function isPetInputMove(type: PetInputPayload["type"]) {
  return type === "move" || type === "pointermove";
}

function isPetInputEnd(type: PetInputPayload["type"]) {
  return (
    type === "up" ||
    type === "cancel" ||
    type === "pointerup" ||
    type === "pointercancel"
  );
}

function withModuleMetrics(state: AppState, now = Date.now()) {
  let changed = false;
  const pets = state.pets.map((pet) => {
    const sampleAt = new Date(
      pet.vitals?.lastSimulatedAt || pet.updatedAt || pet.createdAt || now
    ).getTime();
    const elapsedMinutes = Number.isFinite(sampleAt)
      ? Math.max(0, (now - sampleAt) / 60000)
      : 0;
    if (elapsedMinutes < 0.05) return pet;
    const { moduleState, changed: metricsChanged } = decayModuleMetrics(
      pet,
      state.customModules,
      Math.min(elapsedMinutes, 120)
    );
    if (!metricsChanged) return pet;
    changed = true;
    return { ...pet, moduleState };
  });
  return changed ? { ...state, pets } : state;
}

function withPetVitals(state: AppState, now = Date.now()) {
  const summoned = new Set(state.summonedPetIds);
  let changed = false;
  const pets = state.pets.map((pet) => {
    const current = ensurePetVitals(pet, state.character);
    const next = advancePetVitals(
      current,
      state.character,
      summoned.has(pet.id),
      now
    );
    if (
      next.energy === current.energy &&
      next.initiative === current.initiative &&
      next.relationship === current.relationship &&
        next.zeroEnergySince === current.zeroEnergySince &&
      next.mood === current.mood &&
      next.moodScore === current.moodScore &&
      next.secondsToday === current.secondsToday &&
      next.secondsTotal === current.secondsTotal &&
      next.lastSimulatedAt === current.lastSimulatedAt &&
      next.todayKey === current.todayKey
    ) {
        autoRecallPending.delete(pet.id);
      return pet;
    }
      const zeroSince = new Date(next.zeroEnergySince || 0).getTime();
      const shouldAutoRecall =
        summoned.has(pet.id) &&
        next.energy <= 0.01 &&
        Number.isFinite(zeroSince) &&
        now - zeroSince >= AUTO_RECALL_ZERO_ENERGY_MS;
      if (shouldAutoRecall && !autoRecallPending.has(pet.id)) {
        autoRecallPending.add(pet.id);
        void window.deskPet
          .overlayCommand({ type: "sleep", petId: pet.id })
          .finally(() => autoRecallPending.delete(pet.id));
      } else if (!shouldAutoRecall) {
        autoRecallPending.delete(pet.id);
      }
    changed = true;
    return { ...pet, vitals: next };
  });
  return changed ? { ...state, pets } : state;
}

function withOverlayStats(state: AppState, now = Date.now()) {
  return withPetVitals(withModuleMetrics(state, now), now);
}

function persistPetChanges(previous: AppState, next: AppState) {
  for (const pet of next.pets) {
    const before = previous.pets.find((item) => item.id === pet.id);
    if (!before) continue;
    const vitalsChanged = before.vitals !== pet.vitals;
    const moduleStateChanged = before.moduleState !== pet.moduleState;
    if (!vitalsChanged && !moduleStateChanged) continue;
    void window.deskPet.applyPetPatch(pet.id, {
      ...(vitalsChanged ? { vitals: pet.vitals } : {}),
      ...(moduleStateChanged ? { moduleState: pet.moduleState } : {})
    });
  }
}

function buildSupportSurfaces(icons: DesktopIconRect[]) {
  return [...icons].sort(
    (left, right) => left.y - right.y || left.x - right.x
  );
}

export function MultiPetOverlay() {
  const [appState, setAppState] = useState<AppState | null>(null);
  const appStateRef = useRef<AppState | null>(null);
  const [overlaySettings, setOverlaySettings] =
    useState<AppSettings["overlay"] | null>(null);
  const [metrics, setMetrics] = useState<DisplayMetrics | null>(null);
  const [desktopIcons, setDesktopIcons] = useState<DesktopIconRect[]>([]);
  const [climbPlatforms, setClimbPlatforms] = useState<DesktopIconRect[]>([]);
  const [foodDropNotice, setFoodDropNotice] = useState<
    Record<string, string>
  >({});
  const iconSteps = useMemo(() => {
    const estimate = (values: number[], fallback: number) => {
      const unique = [...new Set(values.map((value) => Math.round(value)))]
        .sort((left, right) => left - right);
      const diffs = unique
        .slice(1)
        .map((value, index) => value - unique[index])
        .filter((value) => value > 8 && value < 500)
        .sort((left, right) => left - right);
      return diffs.length ? diffs[Math.floor(diffs.length / 2)] : fallback;
    };
    return {
      x: estimate(
        desktopIcons.map((icon) => icon.x),
        115
      ),
      y: estimate(
        desktopIcons.map((icon) => icon.y),
        147
      )
    };
  }, [desktopIcons]);
  const registry = useRef(new Map<string, EntitySnapshot>());
  const iconSignatureRef = useRef("");

  useEffect(() => {
    const reportRegions = () => {
      if (typeof window.deskPet.reportPetRegions !== "function") return;
      const regions: PetInteractionRegion[] = Array.from(
        registry.current.values()
      ).map((entity) => ({
        petId: entity.id,
        x: entity.x,
        y: entity.y,
        width: entity.width,
        height: entity.height,
        visible: !suppressedPanelClaims.has(entity.id)
      }));
      window.deskPet.reportPetRegions(regions);
    };

    reportRegions();
    const timer = window.setInterval(reportRegions, 66);
    return () => {
      window.clearInterval(timer);
      if (typeof window.deskPet.reportPetRegions === "function") {
        window.deskPet.reportPetRegions([]);
      }
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    window.deskPet.getState().then((state) => {
      if (!mounted) return;
      const nextState = withOverlayStats(state);
      appStateRef.current = nextState;
      setAppState(nextState);
      setOverlaySettings(nextState.settings.overlay);
      if (nextState !== state) {
        persistPetChanges(state, nextState);
      }
    });
    window.deskPet.getDisplayMetrics().then((nextMetrics) => {
      if (mounted) setMetrics(nextMetrics);
    });
    const refreshIcons = () => {
      void window.deskPet.getDesktopIcons().then((icons) => {
        if (!mounted) return;
        const signature = JSON.stringify(icons);
        if (signature === iconSignatureRef.current) return;
        iconSignatureRef.current = signature;
        setDesktopIcons(icons);
      });
    };
    refreshIcons();
    const iconTimer = window.setInterval(refreshIcons, 30000);
    const stateSubscription = window.deskPet.onStateChanged((state) => {
      appStateRef.current = state;
      setAppState(state);
    });
    const settingsSubscription =
      window.deskPet.onOverlaySettings(setOverlaySettings);
    const displaySubscription = window.deskPet.onDisplayChanged(setMetrics);
    return () => {
      mounted = false;
      stateSubscription();
      settingsSubscription();
      displaySubscription();
      window.clearInterval(iconTimer);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const state = appStateRef.current;
      if (!state) return;
      const nextState = withOverlayStats(state);
      if (nextState === state) return;
      appStateRef.current = nextState;
      setAppState(nextState);
      persistPetChanges(state, nextState);
    }, 60000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const showNotice = (petId: string, text: string) => {
      setFoodDropNotice((current) => ({ ...current, [petId]: text }));
      window.setTimeout(() => {
        setFoodDropNotice((current) => {
          if (current[petId] !== text) return current;
          const next = { ...current };
          delete next[petId];
          return next;
        });
      }, 2600);
    };

    const unsubscribe = window.deskPet.onFoodDrop((payload) => {
      if (!payload.petId) return;
      showNotice(
        payload.petId,
        payload.ok
          ? "好吃！"
          : payload.error || "这个不能吃，只能吃 .food 文件。"
      );
      if (!payload.ok) return;
      if (payload.filePath) {
        setDesktopIcons((current) =>
          current.filter((icon) => icon.foodPath !== payload.filePath)
        );
      }
      const hungerModuleId =
        appStateRef.current?.customModules.find(
          (module) => module.builtinType === "hunger-food"
        )?.id || "";
      if (!hungerModuleId) return;
      void window.deskPet.applyPetPatch(payload.petId, {
        moduleState: { [hungerModuleId]: { hunger: 100 } }
      });
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    return window.deskPet.onClimbPlatformChanged((payload) => {
      setClimbPlatforms((current) => {
        if (payload.closed) {
          return current.filter((platform) => platform.id !== payload.id);
        }
        if (
          !Number.isFinite(payload.x) ||
          !Number.isFinite(payload.y) ||
          !Number.isFinite(payload.width) ||
          !Number.isFinite(payload.height)
        ) {
          return current;
        }
        const nextPlatform: DesktopIconRect = {
          id: payload.id,
          petId: payload.petId,
          name: "攀爬落脚点",
          foodPath: "",
          x: Number(payload.x),
          y: Number(payload.y),
          width: Number(payload.width),
          height: Number(payload.height)
        };
        const existingIndex = current.findIndex(
          (platform) => platform.id === payload.id
        );
        if (existingIndex < 0) {
          return [...current.slice(-3), nextPlatform];
        }
        return current.map((platform, index) =>
          index === existingIndex ? nextPlatform : platform
        );
      });
    });
  }, []);

  function applyDragInteraction(petId: string) {
    const state = appStateRef.current;
    if (!state) return;
    const pet = state.pets.find((item) => item.id === petId);
    if (!pet) return;
    const current = ensurePetVitals(pet, state.character);
    const next = recordPhysicalInteraction(current, Date.now());
    if (next === current) return;
    void window.deskPet.applyPetPatch(pet.id, { vitals: next });
  }

  if (!appState || !overlaySettings || !metrics) return null;
  const summonedPets = appState.summonedPetIds
    .map((petId) => appState.pets.find((pet) => pet.id === petId))
    .filter(Boolean) as PetProfile[];
  const dialogModule = resolveDialogModule(appState);

  return (
    <div className="overlay-root" style={{ pointerEvents: "none" }}>
      {summonedPets.map((pet) => (
        <MultiPetEntity
          key={pet.id}
          pet={pet}
          overlaySettings={overlaySettings}
          metrics={metrics}
          registry={registry}
          canInteract={summonedPets.length > 1}
          dialogModule={dialogModule}
          customModules={appState.customModules}
          voiceProfiles={appState.voiceProfiles}
          desktopIcons={[
            ...desktopIcons,
            ...climbPlatforms.filter((platform) => platform.petId === pet.id)
          ]}
          iconSteps={iconSteps}
          foodNotice={foodDropNotice[pet.id]}
            onDragInteract={() => applyDragInteraction(pet.id)}
          onClimbPlatform={(platform) => {
            const timedPlatform = {
              ...platform,
              petId: pet.id,
              name: "攀爬落脚点",
              foodPath: ""
            };
            setClimbPlatforms((current) => [
              ...current.slice(-3),
              timedPlatform
            ]);
            window.setTimeout(() => {
              setClimbPlatforms((current) =>
                current.filter((item) =>
                  timedPlatform.id
                    ? item.id !== timedPlatform.id
                    : item !== timedPlatform
                )
              );
            }, 5200);
          }}
          onFoodConsumed={(foodPath) =>
            setDesktopIcons((current) =>
              current.filter((icon) => icon.foodPath !== foodPath)
            )
          }
        />
      ))}
    </div>
  );
}

function MultiPetEntity({
  pet,
  overlaySettings,
  metrics,
  registry,
  canInteract,
  dialogModule,
  customModules,
  voiceProfiles
  ,
  desktopIcons,
  iconSteps,
  onClimbPlatform,
  onFoodConsumed,
    onDragInteract,
  foodNotice
}: EntityProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const visualRef = useRef<HTMLDivElement | null>(null);
  const hitboxRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const textBubbleRef = useRef<HTMLElement | null>(null);
  const autoBubbleRef = useRef<HTMLElement | null>(null);
  const voiceIndicatorRef = useRef<HTMLDivElement | null>(null);
  const dragDistanceRef = useRef(0);
  const dragVisualReadyAtRef = useRef(0);
  const dragSessionRef = useRef<DragSession | null>(null);
  const finishDragRef = useRef<(event?: PointerEvent) => void>(() => undefined);
  const updateDragPositionRef = useRef<
    (
      clientX: number,
      clientY: number,
      buttons: number,
      source: DragMoveSource
    ) => void
  >(() => undefined);
  const lastDragMoveRef = useRef({
    x: Number.NaN,
    y: Number.NaN,
    at: 0,
    source: "pointer" as DragMoveSource
  });
  const syncDragPositionRef = useRef<() => void>(() => undefined);
  const freezeMovementRef = useRef(false);
  const [visualState, setVisualState] = useState<
    "idle" | "walk" | "fall" | "land" | "drag" | "sleep"
  >("idle");
  const [direction, setDirection] = useState<1 | -1>(1);
  const visualStateRef = useRef<
    "idle" | "walk" | "fall" | "land" | "drag" | "sleep"
  >("idle");
  const directionRef = useRef<1 | -1>(1);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editLocked, setEditLocked] = useState(false);
  const [textChatOpen, setTextChatOpen] = useState(false);
  const [externalChatOpen, setExternalChatOpen] = useState(false);
  const [panelZ, setPanelZ] = useState(() => nextPanelZIndex());
  const [menuPosition, setMenuPosition] = useState<PanelPosition>({
    left: 8,
    top: 8
  });
  const [textBubblePosition, setTextBubblePosition] = useState<PanelPosition>({
    left: 8,
    top: 8
  });
  const [autoBubblePosition, setAutoBubblePosition] = useState<PanelPosition>({
    left: 8,
    top: 8
  });
  const [voiceIndicatorPosition, setVoiceIndicatorPosition] =
    useState<PanelPosition>({ left: 8, top: 8 });
  const [voicePhase, setVoicePhase] = useState<
    "idle" | "recording" | "transcribing" | "thinking" | "speaking"
  >("idle");
  const [voiceChatOpen, setVoiceChatOpen] = useState(false);
  const [voiceAudioSrc, setVoiceAudioSrc] = useState("");
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const voiceRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceSessionRef = useRef(0);
  const voiceQueueRef = useRef<string[]>([]);
  const voicePlayingRef = useRef(false);
  const voiceVadTimerRef = useRef<number | null>(null);
  const voiceAudioContextRef = useRef<AudioContext | null>(null);
  const voiceMonitorStreamRef = useRef<MediaStream | null>(null);
  const voiceMonitorRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceMonitorTimerRef = useRef<number | null>(null);
  const voiceMonitorContextRef = useRef<AudioContext | null>(null);
  const voiceMonitorTailRef = useRef<Blob[]>([]);
  const voiceMonitorCaptureRef = useRef(false);
  const voiceMonitorStartingRef = useRef(false);
  const nextVoiceLineAtRef = useRef(0);
  const voicePhaseRef = useRef<
    "idle" | "recording" | "transcribing" | "thinking" | "speaking"
  >("idle");
  const isVoiceBusy =
   voicePhase === "transcribing" ||
   voicePhase === "thinking" ||
   voicePhase === "speaking";
  // 所有桌宠共用同一个 overlay 窗口，会话号必须带上桌宠标识才不会互相串音。
  const voiceSessionKey = (value: number) => `${pet.id}:${value}`;
  const foodTargetIdRef = useRef("");
  const nextFoodSeekAtRef = useRef(0);
  const eatingFoodRef = useRef(false);
  const idleActionDurationRef = useRef(3200);
  const climbChainActiveRef = useRef(false);
  const climbChainStepsRef = useRef(0);
  const climbChainHeightRef = useRef(0);
  const climbApproachTargetIdRef = useRef("");
  const nextClimbWindowAtRef = useRef(0);
  const climbGiveUpUntilRef = useRef(0);
  const physicsDebugRef = useRef({
    frames: 0,
    total: 0,
    longFrames: 0,
    maxFrame: 0,
    stoppedEvents: 0,
    supportChanges: 0,
    supportDrops: 0,
    directionChanges: 0,
    lastSupportY: null as number | null,
    lastVx: 0,
    travelled: 0,
    since: performance.now()
  });
  const styleCacheRef = useRef({
    petId: "",
    width: -1,
    height: -1,
    zIndex: -1,
    hostLeft: Number.NaN,
    hostTop: Number.NaN,
    entityX: Number.NaN,
    entityY: Number.NaN,
    collisionSignature: "",
    hitboxLeft: Number.NaN,
    hitboxTop: Number.NaN,
    hitboxWidth: Number.NaN,
    hitboxHeight: Number.NaN
  });
  const voiceProfile = voiceProfiles.find(
    (profile) => profile.id === pet.modulePlugins?.voiceProfileId
  );
  const canTextChat = Boolean(pet.modulePlugins?.aiModuleId);
  const canVoiceChat = Boolean(pet.modulePlugins?.voiceProfileId);
    const autoTextEnabled =
      pet.autoTextEnabled ?? pet.autoDialogueEnabled ?? true;
    const autoVoiceEnabled =
      pet.autoVoiceEnabled ?? pet.autoDialogueEnabled ?? true;
    const canAutoTalk = canTextChat && autoTextEnabled;
  const voiceHasAi = Boolean(
    pet.modulePlugins?.aiModuleId || voiceProfile?.defaultAiModuleId
  );
  const boundModules = customModules.filter((module) =>
    module.enabled !== false &&
    (pet.modulePlugins?.boundModuleIds || []).includes(module.id)
  );

  const climbModule = boundModules.find(
    (module) => module.builtinType === "climb-platforms"
  );
  const hungerModule = boundModules.find(
    (module) => module.builtinType === "hunger-food"
  );
  const hungerMetric = hungerModule?.metrics?.find(
    (metric) => metric.key === "hunger"
  );
  const hunger =
    hungerModule && hungerMetric
      ? readModuleMetric(pet, hungerModule.id, hungerMetric)
      : 100;
  const hungerWarning = Number(hungerMetric?.warnBelow ?? 30);
  const foodTargets = useMemo(
    () => desktopIcons.filter((icon) => Boolean(icon.foodPath)),
    [desktopIcons]
  );
  const supportSurfaces = useMemo(
    () => (climbModule ? buildSupportSurfaces(desktopIcons) : []),
    [desktopIcons, climbModule]
  );

  function setEntityVisual(next: typeof visualState) {
    if (visualStateRef.current === next) return;
    visualStateRef.current = next;
    setVisualState(next);
  }

  function setEntityDirection(next: 1 | -1) {
    if (directionRef.current === next) return;
    directionRef.current = next;
    setDirection(next);
  }

  function promotePanel() {
    setPanelZ(nextPanelZIndex());
  }

  async function triggerClimbPlatform() {
    if (!climbModule) return null;
    const requestAt = performance.now();
    if (requestAt < nextClimbWindowAtRef.current) return null;
    nextClimbWindowAtRef.current =
      requestAt +
      Math.max(1, Number(climbModule.climbJumpIntervalSeconds || 3)) * 1000;
    const result = await window.deskPet.triggerExternalModule(
      climbModule.id,
      pet.id,
      {
        x: physics.current.x + width / 2,
        y: physics.current.y + height,
        stepX: iconSteps.x,
        stepY: iconSteps.y
      }
    );
    if (
      result &&
      typeof result === "object" &&
      "x" in result &&
      "y" in result &&
      "width" in result &&
      "height" in result &&
      "id" in result
    ) {
      const platform: DesktopIconRect = {
        id: String(result.id || ""),
        name: "攀爬落脚点",
        foodPath: "",
        x: Number(result.x),
        y: Number(result.y),
        width: Number(result.width),
        height: Number(result.height)
      };
      onClimbPlatform(platform);
      return platform;
    }
    return null;
  }
    const [chatMessages, setChatMessages] = useState<
      Array<{ id: string; role: "user" | "assistant"; content: string }>
    >([]);
    const [chatDraft, setChatDraft] = useState("");
    const [chatBusy, setChatBusy] = useState(false);
    const [autoReplyOpen, setAutoReplyOpen] = useState(false);
    const [autoReplyText, setAutoReplyText] = useState("");
    const [autoReplyBusy, setAutoReplyBusy] = useState(false);
    const [autoVoiceAudioSrc, setAutoVoiceAudioSrc] = useState("");
    const autoReplyBusyRef = useRef(false);
    const autoReplyTimerRef = useRef<number | null>(null);
    const autoReplyDismissTimerRef = useRef<number | null>(null);
    const autoReplyRequestRef = useRef(0);
    const autoTalkAtRef = useRef(0);
    const autoVoiceEnabledRef = useRef(autoVoiceEnabled);
    const [zIndex, setZIndex] = useState(10);
    const desktopRenderConfig = pet.desktopRenderConfig || pet.renderConfig;
    const scale = (overlaySettings.scale || 1) * (pet.scale || 1);
    const width = (desktopRenderConfig?.hitboxWidth || BASE_WIDTH) * scale;
    const height = (desktopRenderConfig?.hitboxHeight || BASE_HEIGHT) * scale;
  const displayWidth = (desktopRenderConfig?.displayWidth || 260) * scale;
  const displayHeight = (desktopRenderConfig?.displayHeight || 320) * scale;

  useEffect(() => {
    const unsubscribe = subscribeMenuOwner((ownerPetId) => {
      if (ownerPetId !== pet.id) setMenuOpen(false);
    });
    return () => {
      unsubscribe();
    };
  }, [pet.id]);

  useEffect(() => {
    freezeMovementRef.current =
      editLocked ||
      menuOpen ||
      textChatOpen ||
      externalChatOpen ||
      voiceChatOpen ||
      autoReplyOpen;
  }, [
    editLocked,
    menuOpen,
    textChatOpen,
    externalChatOpen,
    voiceChatOpen,
    autoReplyOpen
  ]);

  useEffect(() => {
    if (typeof window.deskPet.onPetChatState !== "function") return;
    return window.deskPet.onPetChatState(({ petId: ownerPetId, open }) => {
      if (ownerPetId !== pet.id) return;
      if (open) {
        setMenuOpen(false);
        setTextChatOpen(false);
        closeVoiceChat();
        stopAutoReply();
        setVoiceAudioSrc("");
        setPanelZ(nextPanelZIndex());
      }
      setExternalChatOpen(open);
    });
  }, [pet.id]);

  useEffect(() => {
    const token = `${pet.id}:menu`;
    if (!menuOpen) {
      clearMenuOwner(pet.id);
      return;
    }
    publishMenuOwner(pet.id);
    setPanelZ(nextPanelZIndex());
    claimPanel(token, {
      petId: pet.id,
      mouse: true,
      focus: false,
      suppressPetInput: true
    });
    return () => {
      releasePanel(token);
      clearMenuOwner(pet.id);
    };
  }, [menuOpen, pet.id]);

  useEffect(() => {
    const token = `${pet.id}:text-chat`;
    if (!textChatOpen) return;
    setPanelZ(nextPanelZIndex());
    claimPanel(token, {
      petId: pet.id,
      mouse: true,
      focus: true,
      suppressPetInput: true
    });
    return () => releasePanel(token);
  }, [pet.id, textChatOpen]);

  useEffect(() => {
    const token = `${pet.id}:voice-chat`;
    if (!voiceChatOpen) return;
    claimPanel(token, {
      petId: pet.id,
      mouse: true,
      focus: false,
      suppressPetInput: true
    });
    return () => releasePanel(token);
  }, [pet.id, voiceChatOpen]);

  useEffect(() => {
    const token = `${pet.id}:auto-reply`;
    if (!autoReplyOpen) return;
    claimPanel(token, {
      petId: pet.id,
      mouse: true,
      focus: false,
      suppressPetInput: true
    });
    return () => releasePanel(token);
  }, [autoReplyOpen, pet.id]);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const element = menuRef.current;
    if (!element) return;
    const next = positionBesideDisplay(
      getPanelAnchorRect(),
      element.offsetWidth || 178,
      element.offsetHeight || 120
    );
    setMenuPosition(next);
  }, [menuOpen, panelZ]);

  useLayoutEffect(() => {
    if (!textChatOpen) return;
    const element = textBubbleRef.current;
    if (!element) return;
    const next = positionAboveDisplay(
      getPanelAnchorRect(),
      element.offsetWidth || 300,
      element.offsetHeight || 240
    );
    setTextBubblePosition(next);
  }, [textChatOpen, panelZ]);

  useEffect(() => {
    if (!autoReplyOpen) return;
    const update = () => {
      const element = autoBubbleRef.current;
      if (!element) return;
      const next = positionAboveDisplay(
        getPanelAnchorRect(),
        element.offsetWidth || 300,
        element.offsetHeight || 120
      );
      setAutoBubblePosition((current) =>
        current.left === next.left && current.top === next.top
          ? current
          : next
      );
    };
    update();
    const timer = window.setInterval(update, 175);
    window.addEventListener("resize", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", update);
    };
  }, [autoReplyOpen]);

  useEffect(() => {
    if (!voiceChatOpen) return;
    const update = () => {
      const element = voiceIndicatorRef.current;
      if (!element) return;
      const next = positionAboveDisplay(
        getPanelAnchorRect(),
        element.offsetWidth || 280,
        element.offsetHeight || 56
      );
      setVoiceIndicatorPosition((current) =>
        current.left === next.left && current.top === next.top
          ? current
          : next
      );
    };
    update();
    const timer = window.setInterval(update, 175);
    window.addEventListener("resize", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", update);
    };
  }, [voiceChatOpen]);

    useEffect(() => {
      if (!canAutoTalk) {
        autoTalkAtRef.current = 0;
        return;
      }
      if (!autoTalkAtRef.current) {
        autoTalkAtRef.current =
          Date.now() +
          nextAutoTalkDelayMs(Number(pet.vitals?.initiative ?? 58));
      }
      const timer = window.setInterval(() => {
        if (Date.now() < autoTalkAtRef.current) return;
        if (
          autoReplyBusyRef.current ||
          textChatOpen ||
          externalChatOpen ||
          voiceChatOpen ||
          menuOpen ||
          voiceAudioSrc ||
          autoVoiceAudioSrc ||
          chatBusy ||
          isVoiceBusy
        ) {
          return;
        }
        autoTalkAtRef.current =
          Date.now() +
          nextAutoTalkDelayMs(Number(pet.vitals?.initiative ?? 58));
        void triggerAutoDialogue();
      }, 10000);
      return () => window.clearInterval(timer);
    }, [
      canAutoTalk,
      canVoiceChat,
      autoVoiceEnabled,
      pet.id,
      pet.modulePlugins?.aiModuleId,
      pet.modulePlugins?.voiceProfileId,
      pet.vitals?.initiative,
      textChatOpen,
      externalChatOpen,
      voiceChatOpen,
      menuOpen,
      voiceAudioSrc,
      autoVoiceAudioSrc,
      chatBusy,
      isVoiceBusy
    ]);

    useEffect(() => {
      if (autoTextEnabled) return;
      stopAutoReply();
    }, [autoTextEnabled]);

    useEffect(() => {
      if (autoVoiceEnabled) return;
      setAutoVoiceAudioSrc("");
      if (!voiceChatOpen && voicePhaseRef.current === "idle") {
        setVoiceAudioSrc("");
      }
    }, [autoVoiceEnabled, voiceChatOpen]);

    useEffect(() => {
      autoVoiceEnabledRef.current = autoVoiceEnabled;
    }, [autoVoiceEnabled]);

    useEffect(
      () => () => {
        if (autoReplyTimerRef.current !== null) {
          window.clearInterval(autoReplyTimerRef.current);
        }
        if (autoReplyDismissTimerRef.current !== null) {
          window.clearTimeout(autoReplyDismissTimerRef.current);
        }
      },
      []
    );
  const visual = getVisualSize(desktopRenderConfig);
  const visualWidth = visual.visualWidth * scale;
  const visualHeight = visual.visualHeight * scale;
  const bounds = useMemo(
    () => ({
      left: metrics.workArea.x - metrics.bounds.x,
      right:
        metrics.workArea.x + metrics.workArea.width - metrics.bounds.x,
      floor: metrics.workArea.y + metrics.workArea.height - metrics.bounds.y
    }),
    [metrics]
  );
  const physics = useRef<PhysicsState>({
    id: pet.id,
    x: bounds.left + 80 + Math.random() * 180,
    y: bounds.floor - height,
    width,
    height,
    displayWidth,
    displayHeight,
    hitboxOffsetX: (desktopRenderConfig?.hitboxOffsetX || 0) * scale,
    hitboxOffsetY: (desktopRenderConfig?.hitboxOffsetY || 0) * scale,
    vx: 0,
    vy: 0,
    direction: 1,
    directionY: -1,
    passUntil: 0,
    zIndex: 10,
    dragging: false,
    grounded: true,
    visualOffsetX: 0,
    visualOffsetY: 0,
    dragOffsetX: 0,
    dragOffsetY: 0,
    lastPointerX: 0,
    lastPointerY: 0,
    lastPointerAt: 0,
    nextIdleAt: performance.now() + 3000,
    nextJumpAt: performance.now() + 1800,
    idleUntil: 0
    ,
    restingUntil: 0,
    thrown: false,
    supportY: null,
    supportLeft: null,
    supportRight: null,
    supportId: null,
    supportGraceUntil: 0,
    nextDirectionAt: performance.now() + 4000,
    pendingJumpAt: 0,
    pendingJumpVx: 0,
    pendingJumpVy: 0,
    fallbackRequested: false
  });
  const configuredWalkSpeed = Number(overlaySettings.walkSpeed || 63);
  const effectiveWalkSpeed =
    63 * Math.pow(Math.max(1, configuredWalkSpeed) / 63, 1.35);
  const animationSpeed = Math.min(
    4.5,
    Math.max(0.3, Math.pow(Math.max(1, configuredWalkSpeed) / 77, 1.25))
  );
  const friction = clamp(overlaySettings.friction ?? 45, 0, 100) / 100;
  const wallBounce = clamp(overlaySettings.wallBounce ?? 55, 0, 100) / 100;
  const groundBounce =
    clamp(overlaySettings.groundBounce ?? 45, 0, 100) / 100;

  function getPanelAnchorRect() {
    const entity = physics.current;
    const styleCache = styleCacheRef.current;
    const hitboxPosition = getHitboxPosition({
      displayWidth,
      displayHeight,
      hitboxWidth: entity.width,
      hitboxHeight: entity.height,
      hitboxOffsetX: entity.hitboxOffsetX,
      hitboxOffsetY: entity.hitboxOffsetY,
      direction: entity.direction
    });
    const hostLeft = Number.isFinite(styleCache.hostLeft)
      ? styleCache.hostLeft
      : entity.x - hitboxPosition.left;
    const hostTop = Number.isFinite(styleCache.hostTop)
      ? styleCache.hostTop
      : entity.y - hitboxPosition.top;
    const anchorWidth = Math.max(
      1,
      Math.min(displayWidth, visualWidth)
    );
    const anchorHeight = Math.max(
      1,
      Math.min(displayHeight, visualHeight)
    );
    const centerX =
      hostLeft +
      displayWidth / 2 +
      (desktopRenderConfig?.offsetX || 0) * scale * entity.direction;
    const centerY =
      hostTop +
      displayHeight / 2 +
      (desktopRenderConfig?.offsetY || 0) * scale;
    return {
      x: centerX - anchorWidth / 2,
      y: centerY - anchorHeight / 2,
      width: anchorWidth,
      height: anchorHeight
    };
  }

  function sync() {
    const entity = physics.current;
    const styleCache = styleCacheRef.current;
    const nextHitboxOffsetX =
      (desktopRenderConfig?.hitboxOffsetX || 0) * scale;
    const nextHitboxOffsetY =
      (desktopRenderConfig?.hitboxOffsetY || 0) * scale;
    const nearlyEqual = (left: number, right: number) =>
      Math.abs(left - right) < 0.001;
    const displayUnchanged =
      styleCache.petId === pet.id &&
      nearlyEqual(styleCache.width, displayWidth) &&
      nearlyEqual(styleCache.height, displayHeight);
    const collisionSignature = [
      width,
      height,
      nextHitboxOffsetX,
      nextHitboxOffsetY,
      entity.direction
    ].join("|");
    const collisionChanged =
      styleCache.collisionSignature !== collisionSignature;
    const keepVisualAnchor =
      displayUnchanged &&
      collisionChanged &&
      Number.isFinite(styleCache.hostLeft) &&
      Number.isFinite(styleCache.hostTop);
    const entityDeltaX = Number.isFinite(styleCache.entityX)
      ? entity.x - styleCache.entityX
      : 0;
    const entityDeltaY = Number.isFinite(styleCache.entityY)
      ? entity.y - styleCache.entityY
      : 0;
    const targetHostLeft = styleCache.hostLeft + entityDeltaX;
    const targetHostTop = styleCache.hostTop + entityDeltaY;
    if (!displayUnchanged) {
      entity.visualOffsetX = 0;
      entity.visualOffsetY = 0;
    }
    entity.width = width;
    entity.height = height;
    entity.displayWidth = displayWidth;
    entity.displayHeight = displayHeight;
    entity.hitboxOffsetX = nextHitboxOffsetX;
    entity.hitboxOffsetY = nextHitboxOffsetY;
    const hitboxPosition = getHitboxPosition({
      displayWidth,
      displayHeight,
      hitboxWidth: entity.width,
      hitboxHeight: entity.height,
      hitboxOffsetX: entity.hitboxOffsetX,
      hitboxOffsetY: entity.hitboxOffsetY,
      direction: entity.direction
    });
    if (keepVisualAnchor) {
      // Re-anchor the collision rectangle without moving the visible host.
      // The persistent visual offset keeps that anchor stable if physics clamps
      // the hitbox at a wall or floor after edit mode unlocks.
      entity.x = targetHostLeft + hitboxPosition.left;
      entity.y = targetHostTop + hitboxPosition.top;
      const leftLimit = bounds.left;
      const rightLimit = Math.max(bounds.left, bounds.right - width);
      if (entity.x < leftLimit || entity.x > rightLimit) {
        entity.x = clamp(entity.x, leftLimit, rightLimit);
        entity.vx = 0;
      }
      if (entity.grounded && entity.supportY !== null) {
        entity.y = Math.min(bounds.floor, entity.supportY) - height;
        entity.vy = 0;
      } else if (entity.y + height >= bounds.floor) {
        entity.y = bounds.floor - height;
        entity.vy = 0;
        entity.grounded = true;
        entity.supportY = bounds.floor;
        entity.supportLeft = bounds.left;
        entity.supportRight = bounds.right;
        entity.supportId = "floor";
        entity.supportGraceUntil = 0;
      }
      entity.visualOffsetX =
        targetHostLeft - (entity.x - hitboxPosition.left);
      entity.visualOffsetY =
        targetHostTop - (entity.y - hitboxPosition.top);
    }
    const hostLeft =
      entity.x - hitboxPosition.left + entity.visualOffsetX;
    const hostTop =
      entity.y - hitboxPosition.top + entity.visualOffsetY;
    styleCache.petId = pet.id;
    styleCache.hostLeft = hostLeft;
    styleCache.hostTop = hostTop;
    styleCache.entityX = entity.x;
    styleCache.entityY = entity.y;
    styleCache.collisionSignature = collisionSignature;
    if (hostRef.current) {
      hostRef.current.style.transform = `translate3d(${hostLeft}px, ${hostTop}px, 0)`;
      if (styleCache.width !== displayWidth) {
        hostRef.current.style.width = `${displayWidth}px`;
        styleCache.width = displayWidth;
      }
      if (styleCache.height !== displayHeight) {
        hostRef.current.style.height = `${displayHeight}px`;
        styleCache.height = displayHeight;
      }
      if (styleCache.zIndex !== zIndex) {
        hostRef.current.style.zIndex = String(zIndex);
        styleCache.zIndex = zIndex;
      }
    }
    if (hitboxRef.current) {
      if (styleCache.hitboxLeft !== hitboxPosition.left) {
        hitboxRef.current.style.left = `${hitboxPosition.left}px`;
        styleCache.hitboxLeft = hitboxPosition.left;
      }
      if (styleCache.hitboxTop !== hitboxPosition.top) {
        hitboxRef.current.style.top = `${hitboxPosition.top}px`;
        styleCache.hitboxTop = hitboxPosition.top;
      }
      if (styleCache.hitboxWidth !== entity.width) {
        hitboxRef.current.style.width = `${entity.width}px`;
        styleCache.hitboxWidth = entity.width;
      }
      if (styleCache.hitboxHeight !== entity.height) {
        hitboxRef.current.style.height = `${entity.height}px`;
        styleCache.hitboxHeight = entity.height;
      }
    }
    entity.menu = undefined;
    const snapshot = registry.current.get(pet.id);
    if (snapshot) {
      Object.assign(snapshot, entity);
    } else {
      registry.current.set(pet.id, { ...entity });
    }
  }

  syncDragPositionRef.current = sync;

  function queueJumpTo(
    entity: PhysicsState,
    target: DesktopIconRect,
    now: number
  ) {
    if (!climbModule) return;
    entity.fallbackRequested = false;
    const gravity = Number(overlaySettings.gravity || 1800);
    const currentCenterX = entity.x + width / 2;
    const targetCenterX = target.x + target.width / 2;
    const heightDiff = Math.max(
      24,
      entity.y + height - target.y
    );
    const maximumHorizontalSpeed = 520;
    let jumpVy = -Math.sqrt(2 * gravity * heightDiff) * 1.03;
    let flightTime = Math.max(
      0.18,
      (2 * Math.abs(jumpVy)) / gravity
    );
    const desiredHorizontalSpeed =
      Math.abs(targetCenterX - currentCenterX) / flightTime;
    if (desiredHorizontalSpeed > maximumHorizontalSpeed) {
      flightTime =
        Math.abs(targetCenterX - currentCenterX) /
        maximumHorizontalSpeed;
      jumpVy = -Math.max(
        Math.abs(jumpVy),
        (gravity * flightTime) / 2
      );
    }
    const jumpVx = clamp(
      (targetCenterX - currentCenterX) / flightTime,
      -maximumHorizontalSpeed,
      maximumHorizontalSpeed
    );
    const targetDirection: 1 | -1 =
      targetCenterX >= currentCenterX ? 1 : -1;

    if (entity.direction !== targetDirection) {
      entity.direction = targetDirection;
      entity.vx = 0;
      entity.pendingJumpAt = now + 220;
      entity.pendingJumpVx = jumpVx;
      entity.pendingJumpVy = jumpVy;
      setEntityDirection(targetDirection);
      setEntityVisual("walk");
      return;
    }

    entity.vx = jumpVx;
    entity.vy = jumpVy;
    entity.grounded = false;
    entity.supportY = null;
    entity.supportLeft = null;
    entity.supportRight = null;
    entity.supportId = null;
    setEntityVisual("fall");
  }

  function chooseFoodTarget(now: number) {
    if (!hungerModule || hunger >= 100 || foodTargets.length === 0) {
      if (hunger >= 100) foodTargetIdRef.current = "";
      return null;
    }

    const activeTarget = foodTargets.find(
      (target) => target.foodPath === foodTargetIdRef.current
    );
    if (activeTarget) return activeTarget;

    const nearestTarget = () =>
      [...foodTargets].sort((left, right) => {
        const leftDistance = Math.hypot(
          left.x + left.width / 2 - (physics.current.x + width / 2),
          left.y - (physics.current.y + height)
        );
        const rightDistance = Math.hypot(
          right.x + right.width / 2 - (physics.current.x + width / 2),
          right.y - (physics.current.y + height)
        );
        return leftDistance - rightDistance;
      })[0] || null;

    if (hunger <= 30) {
      const target = nearestTarget();
      foodTargetIdRef.current = target?.foodPath || "";
      return target;
    }

    if (now < nextFoodSeekAtRef.current) return null;
    nextFoodSeekAtRef.current =
      now +
      Math.max(3, Number(hungerModule.foodSeekIntervalSeconds || 8)) *
        1000;
    const chance = clamp(10 + ((100 - hunger) / 70) * 80, 10, 90);
    if (Math.random() * 100 >= chance) return null;
    const target = nearestTarget();
    foodTargetIdRef.current = target?.foodPath || "";
    return target;
  }

  async function consumeFoodTarget(target: DesktopIconRect) {
    if (eatingFoodRef.current || !target.foodPath) return;
    eatingFoodRef.current = true;
    try {
      const result = await window.deskPet.consumeFood(target.foodPath);
      if (!result.ok) return;
      foodTargetIdRef.current = "";
      onFoodConsumed(target.foodPath);
      if (!hungerModule) return;
      await window.deskPet.applyPetPatch(pet.id, {
        moduleState: { [hungerModule.id]: { hunger: 100 } }
      });
    } finally {
      eatingFoodRef.current = false;
    }
  }

  function handleFoodSeeking(
    entity: PhysicsState,
    target: DesktopIconRect,
    now: number
  ) {
    const currentCenterX = entity.x + width / 2;
    const currentBottom = entity.y + height;
    const targetCenterX = target.x + target.width / 2;
    const horizontalDistance = Math.abs(currentCenterX - targetCenterX);
    const verticalDistance = currentBottom - target.y;
    const aligned =
      horizontalDistance <= Math.max(20, target.width * 0.72);

    if (
      aligned &&
      Math.abs(verticalDistance) <= Math.max(20, target.height * 0.4)
    ) {
      void consumeFoodTarget(target);
      return;
    }

    if (climbModule && verticalDistance > 12) {
      if (aligned && verticalDistance <= iconSteps.y * 2.1) {
        queueJumpTo(entity, target, now);
        return;
      }

      const intermediateTarget = desktopIcons
        .filter(
          (icon) =>
            icon.y < currentBottom - 8 &&
            icon.y > target.y + 8 &&
            currentBottom - icon.y <= iconSteps.y * 2.1 &&
            Math.abs(
              icon.x + icon.width / 2 - currentCenterX
            ) <=
              iconSteps.x * 2.1
        )
        .sort((left, right) => {
          const leftScore =
            Math.abs(left.y - target.y) +
            Math.abs(left.x + left.width / 2 - targetCenterX) * 0.35;
          const rightScore =
            Math.abs(right.y - target.y) +
            Math.abs(right.x + right.width / 2 - targetCenterX) * 0.35;
          return leftScore - rightScore;
        })[0];

      if (intermediateTarget) {
        queueJumpTo(entity, intermediateTarget, now);
        return;
      }

      void triggerClimbPlatform().then((platform) => {
        if (!platform || !entity.grounded || entity.dragging) return;
        queueJumpTo(entity, platform, performance.now());
      });
      return;
    }

    const direction: 1 | -1 =
      targetCenterX >= currentCenterX ? 1 : -1;
    entity.direction = direction;
    entity.vx = effectiveWalkSpeed * direction;
    entity.idleUntil = 0;
    entity.thrown = false;
    setEntityDirection(direction);
    setEntityVisual("walk");
  }

  function climbGridDistance(entity: PhysicsState, target: DesktopIconRect) {
    const horizontal = Math.abs(
      target.x + target.width / 2 - (entity.x + width / 2)
    ) / Math.max(1, iconSteps.x);
    const vertical = Math.max(
      0,
      entity.y + height - target.y
    ) / Math.max(1, iconSteps.y);
    return { horizontal, vertical, total: horizontal + vertical };
  }

  function beginClimbJump(
    entity: PhysicsState,
    target: DesktopIconRect,
    now: number
  ) {
    const distance = climbGridDistance(entity, target);
    climbChainActiveRef.current = true;
    climbChainStepsRef.current += 1;
    climbChainHeightRef.current += distance.vertical;
    entity.nextJumpAt = now + 350;
    queueJumpTo(entity, target, now);
  }

  function endClimbChain(entity: PhysicsState, now: number) {
    climbChainActiveRef.current = false;
    climbChainStepsRef.current = 0;
    climbChainHeightRef.current = 0;
    climbApproachTargetIdRef.current = "";
    const waitSeconds = Math.max(
      1,
      Number(climbModule?.climbJumpIntervalSeconds || 3)
    );
    entity.nextJumpAt = now + waitSeconds * 1000;
  }

  function currentClimbChance() {
    if (!climbModule) return 0;
    if (!climbChainActiveRef.current) {
      return Number(climbModule.climbJumpChance ?? 65);
    }
    const base = Number(climbModule.climbChainChance ?? 90);
    const chainDecay = Math.pow(
      Number(climbModule.climbChainDecay ?? 0.65),
      climbChainStepsRef.current
    );
    const heightDecay = Math.pow(
      Number(climbModule.climbHeightDecay ?? 0.8),
      climbChainHeightRef.current
    );
    return clamp(base * chainDecay * heightDecay, 0, 100);
  }

  function shouldApproachClimbTarget() {
    if (!climbModule) return false;
    const chance = clamp(
      Number(climbModule.climbApproachChance ?? 45),
      0,
      100
    );
    return Math.random() * 100 < chance;
  }

  function hasLandingAhead(entity: PhysicsState) {
    const gravity = Math.max(1, Number(overlaySettings.gravity || 1800));
    const lookAhead = clamp(
      Math.abs(entity.vy) / gravity + 0.12,
      0.16,
      0.6
    );
    const predictedX = entity.x + entity.vx * lookAhead;
    const predictedBottom =
      entity.y +
      height +
      entity.vy * lookAhead +
      0.5 * gravity * lookAhead * lookAhead;
    return supportSurfaces.some(
      (surface) =>
        surface.y >= entity.y + height - 8 &&
        surface.y <= predictedBottom + iconSteps.y * 0.65 &&
        predictedX + width * 0.64 > surface.x + 2 &&
        predictedX + width * 0.36 < surface.x + surface.width - 2
    );
  }

  function requestAirborneFallback(entity: PhysicsState, now: number) {
    if (
      !climbModule ||
      performance.now() < climbGiveUpUntilRef.current ||
      entity.dragging ||
      entity.thrown ||
      entity.fallbackRequested ||
      entity.vy < 120
    ) {
      return;
    }
    const remainingDrop = bounds.floor - (entity.y + height);
    if (
      remainingDrop < iconSteps.y * 0.5 ||
      hasLandingAhead(entity)
    ) {
      return;
    }
    entity.fallbackRequested = true;
    entity.nextJumpAt = now + 700;
    void triggerClimbPlatform().then((platform) => {
      if (!platform) {
        entity.fallbackRequested = false;
        return;
      }
      if (entity.dragging || entity.grounded) return;
      beginClimbJump(entity, platform, performance.now());
    });
  }

  function updateGroundedBehavior(
    entity: PhysicsState,
    now: number,
    wasFalling: boolean
  ) {
    if (entity.thrown) {
      if (friction >= 0.99 || Math.abs(entity.vx) < 4) {
        if (friction >= 0.99) entity.vx = 0;
        entity.thrown = false;
      }
    }

    if (
      climbModule &&
      entity.pendingJumpAt > 0 &&
      entity.idleUntil <= now &&
      now >= entity.pendingJumpAt
    ) {
      entity.vx = entity.pendingJumpVx;
      entity.vy = entity.pendingJumpVy;
      entity.pendingJumpAt = 0;
      entity.grounded = false;
      entity.supportY = null;
      entity.supportLeft = null;
      entity.supportRight = null;
      entity.supportId = null;
      setEntityVisual("fall");
      return;
    }

    const foodTarget =
      entity.idleUntil <= now ? chooseFoodTarget(now) : null;
    if (foodTarget) {
      handleFoodSeeking(entity, foodTarget, now);
      return;
    }

    if (
      climbModule &&
      climbGiveUpUntilRef.current <= now &&
      entity.supportY !== null &&
      entity.idleUntil <= now
    ) {
      const maxClimbSteps = Math.max(1, Number(climbModule.climbMaxSteps || 3));
      if (climbChainStepsRef.current >= maxClimbSteps) {
        endClimbChain(entity, now);
        climbGiveUpUntilRef.current =
          now +
          Math.max(1, Number(climbModule.climbJumpIntervalSeconds || 3)) * 1000;
        entity.idleUntil = now + 800;
        entity.vx = effectiveWalkSpeed * (Math.random() > 0.5 ? 1 : -1);
        setEntityVisual("walk");
        return;
      }
      const currentCenterX = entity.x + width / 2;
      const upwardIcons = desktopIcons.filter(
        (icon) =>
          icon.y < entity.supportY! - 8 &&
          entity.supportY! - icon.y <= iconSteps.y * 2.1
      );
      const distanceTo = (target: DesktopIconRect) =>
        climbGridDistance(entity, target);
      const reachableTargets = upwardIcons.filter(
        (target) => distanceTo(target).total <= 2.05
      );
      const sameColumnTargets = reachableTargets
        .filter((target) => distanceTo(target).horizontal <= 0.55)
        .sort((left, right) => left.y - right.y);
      const reachableTarget = sameColumnTargets[0] ||
        [...reachableTargets].sort((left, right) => {
          const leftDistance = distanceTo(left);
          const rightDistance = distanceTo(right);
          return (
            leftDistance.total - rightDistance.total ||
            leftDistance.horizontal - rightDistance.horizontal
          );
        })[0];

      const approachTarget =
        upwardIcons.find(
          (icon) => icon.id === climbApproachTargetIdRef.current
        ) || null;
      if (approachTarget) {
        const approachDistance = distanceTo(approachTarget);
        if (approachDistance.total > 2.05) {
          const direction: 1 | -1 =
            approachTarget.x + approachTarget.width / 2 >= currentCenterX
              ? 1
              : -1;
          entity.direction = direction;
          entity.vx = effectiveWalkSpeed * direction;
          entity.nextJumpAt = now + 250;
          setEntityDirection(direction);
          setEntityVisual("walk");
          return;
        }
        climbApproachTargetIdRef.current = "";
        beginClimbJump(entity, approachTarget, now);
        return;
      }

      if (now >= entity.nextJumpAt) {
        const chance = currentClimbChance();
        if (Math.random() * 100 >= chance) {
          endClimbChain(entity, now);
        } else if (reachableTarget) {
          if (!shouldApproachClimbTarget()) {
            endClimbChain(entity, now);
            return;
          }
          beginClimbJump(entity, reachableTarget, now);
          return;
        } else {
          const nextApproachTarget = [...upwardIcons].sort(
            (left, right) => {
              const leftDistance = distanceTo(left);
              const rightDistance = distanceTo(right);
              return (
                leftDistance.total - rightDistance.total ||
                leftDistance.horizontal - rightDistance.horizontal
              );
            }
          )[0];
          if (nextApproachTarget) {
            if (!shouldApproachClimbTarget()) {
              endClimbChain(entity, now);
              return;
            }
            climbApproachTargetIdRef.current =
              nextApproachTarget.id ||
              `${nextApproachTarget.x}:${nextApproachTarget.y}`;
            const direction: 1 | -1 =
              nextApproachTarget.x + nextApproachTarget.width / 2 >=
              currentCenterX
                ? 1
                : -1;
            entity.direction = direction;
            entity.vx = effectiveWalkSpeed * direction;
            entity.nextJumpAt = now + 250;
            setEntityDirection(direction);
            setEntityVisual("walk");
            return;
          }

          entity.nextJumpAt =
            now +
            Math.max(1, Number(climbModule?.climbJumpIntervalSeconds || 3)) * 1000;
          void triggerClimbPlatform().then((platform) => {
            if (!entity.grounded || entity.dragging) return;
            if (platform) {
              beginClimbJump(entity, platform, performance.now());
              return;
            }
            endClimbChain(entity, performance.now());
          });
          return;
        }
      }
    }

    if (!overlaySettings.idleActionEnabled) {
      entity.idleUntil = 0;
      if (Math.abs(entity.vx) < 4) {
        chooseRoamDirection(entity, now);
        entity.vx = effectiveWalkSpeed * entity.direction;
      }
      setEntityDirection(entity.direction);
      setEntityVisual("walk");
    } else if (entity.idleUntil > now) {
      entity.vx = 0;
      setEntityVisual("idle");
    } else if (now >= entity.nextIdleAt) {
      const seconds = Math.max(
        5,
        Number(overlaySettings.idleActionIntervalSeconds || 20)
      );
      entity.nextIdleAt = now + seconds * 1000;
      if (Math.random() * 100 < overlaySettings.idleActionChance) {
        entity.vx = 0;
        entity.idleUntil = now + idleActionDurationRef.current;
        setEntityVisual("idle");
      } else {
        chooseRoamDirection(entity, now);
        entity.vx = effectiveWalkSpeed * entity.direction;
        setEntityDirection(entity.direction);
        setEntityVisual("walk");
      }
    } else if (Math.abs(entity.vx) > 4) {
      setEntityVisual("walk");
    } else {
      chooseRoamDirection(entity, now);
      entity.vx = effectiveWalkSpeed * entity.direction;
      setEntityDirection(entity.direction);
      setEntityVisual("walk");
    }

    if (wasFalling) setEntityVisual("land");
  }

  function chooseRoamDirection(entity: PhysicsState, now: number) {
    // 抛掷飞行中保持朝向跟随速度，避免出现“倒着飞/倒着走”。
    if (entity.thrown) return;
    if (now < entity.nextDirectionAt) return;
    entity.direction = Math.random() > 0.5 ? 1 : -1;
    entity.directionY = Math.random() > 0.5 ? 1 : -1;
    entity.nextDirectionAt =
      now + 3500 + Math.random() * 12000;
  }

  useEffect(() => {
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const delta = Math.min(0.04, (now - previous) / 1000);
      if (window.deskPet.physicsDebug) {
        const stats = physicsDebugRef.current;
        stats.frames += 1;
        stats.total += delta * 1000;
        if (delta > 0.025) stats.longFrames += 1;
        stats.maxFrame = Math.max(stats.maxFrame, delta * 1000);
        if (
          stats.lastSupportY !== null &&
          stats.lastSupportY !== bounds.floor &&
          physics.current.supportY === null
        ) {
          stats.supportDrops += 1;
        }
        if (stats.lastSupportY !== physics.current.supportY) {
          stats.lastSupportY = physics.current.supportY;
          stats.supportChanges += 1;
        }
        if (
          stats.lastVx !== 0 &&
          physics.current.vx !== 0 &&
          Math.sign(stats.lastVx) !== Math.sign(physics.current.vx)
        ) {
          stats.directionChanges += 1;
        }
        stats.lastVx = physics.current.vx;
        stats.travelled += Math.abs(physics.current.vx * delta);
        if (
          visualStateRef.current === "walk" &&
          Math.abs(physics.current.vx) < 1
        ) {
          stats.stoppedEvents += 1;
        }
        if (stats.frames >= 180) {
          window.deskPet.debugPhysicsLog(
            `[physics-debug] avg=${(
              stats.total / stats.frames
            ).toFixed(2)}ms long=${stats.longFrames} max=${stats.maxFrame.toFixed(
              2
            )}ms support=${String(
              physics.current.supportY
            )} platform=${String(
              physics.current.supportY !== null &&
                physics.current.supportY !== bounds.floor
            )} left=${String(physics.current.supportLeft)} right=${String(
              physics.current.supportRight
            )} floor=${bounds.floor.toFixed(1)} state=${
              visualStateRef.current
            } vx=${physics.current.vx.toFixed(
              1
            )} x=${physics.current.x.toFixed(1)} travelled=${stats.travelled.toFixed(
              1
            )} stops=${stats.stoppedEvents} supportChanges=${
              stats.supportChanges
            } supportDrops=${stats.supportDrops} directionChanges=${
              stats.directionChanges
            }`
          );
          stats.frames = 0;
          stats.total = 0;
          stats.longFrames = 0;
          stats.maxFrame = 0;
          stats.stoppedEvents = 0;
          stats.supportChanges = 0;
          stats.supportDrops = 0;
          stats.directionChanges = 0;
          stats.travelled = 0;
        }
      }
      previous = now;
      const entity = physics.current;

      if (freezeMovementRef.current && !entity.dragging) {
        entity.vx = 0;
        entity.vy = 0;
        setEntityVisual("idle");
        sync();
        frame = requestAnimationFrame(tick);
        return;
      }

      if (entity.dragging) {
        if (now >= dragVisualReadyAtRef.current) {
          setEntityVisual("drag");
        }
      } else if (entity.restingUntil > now) {
        entity.vx = 0;
        entity.vy = 0;
        setEntityVisual("sleep");
      } else if (!overlaySettings.gravityLocked) {
        if (
          climbModule &&
          entity.idleUntil <= now &&
          now >= entity.nextJumpAt
        ) {
          entity.fallbackRequested = false;
          entity.vy = -Math.max(80, effectiveWalkSpeed * 1.15);
          entity.directionY = -1;
          entity.nextJumpAt =
            now +
            Math.max(1, Number(climbModule?.climbJumpIntervalSeconds || 3)) *
              1000;
          if (
            climbModule &&
            Math.random() * 100 <
              (Number(climbModule.climbJumpChance ?? 65) *
                Number(climbModule.climbChance ?? 55)) /
                100
          ) {
            void triggerClimbPlatform();
          }
        }
        const freeFoodTarget = chooseFoodTarget(now);
        if (freeFoodTarget) {
          const targetCenterX =
            freeFoodTarget.x + freeFoodTarget.width / 2;
          const targetCenterY =
            freeFoodTarget.y + freeFoodTarget.height / 2;
          const entityCenterX = entity.x + width / 2;
          const entityCenterY = entity.y + height / 2;
          const dx = targetCenterX - entityCenterX;
          const dy = targetCenterY - entityCenterY;
          const distance = Math.hypot(dx, dy);
          if (distance <= Math.max(24, width * 0.8)) {
            entity.vx = 0;
            entity.vy = 0;
            void consumeFoodTarget(freeFoodTarget);
          } else {
            const speed = Math.max(effectiveWalkSpeed, 70);
            entity.vx = (dx / distance) * speed;
            entity.vy = (dy / distance) * speed;
            entity.direction = dx < 0 ? -1 : 1;
            entity.thrown = false;
            setEntityDirection(entity.direction);
          }
        } else if (entity.idleUntil > now) {
          entity.vx = 0;
          entity.vy = 0;
          setEntityVisual("idle");
        } else {
          chooseRoamDirection(entity, now);
            if (entity.thrown) {
              // 抛掷后先保留惯性，等停下来了再回到正常行走。
              if (Math.abs(entity.vx) < 4 || Math.abs(entity.vy) < 4) {
                entity.vx = effectiveWalkSpeed * entity.direction;
                entity.vy = effectiveWalkSpeed * entity.directionY;
                entity.thrown = false;
              }
            } else {
              // 自由移动模式下朝向就是移动方向。必须每帧同步：
              // 否则朝向变了速度还没跟上，就会看到桌宠“倒着走”。
              entity.vx = effectiveWalkSpeed * entity.direction;
              entity.vy = effectiveWalkSpeed * entity.directionY;
            }
          if (entity.thrown) {
            const amount = Math.pow(friction, 1.45) * 520 * delta;
            const speed = Math.hypot(entity.vx, entity.vy);
            if (speed > 0) {
              const ratio = Math.max(0, speed - amount) / speed;
              entity.vx *= ratio;
              entity.vy *= ratio;
            }
            if (Math.hypot(entity.vx, entity.vy) < 20) {
              entity.vx = 0;
              entity.vy = 0;
              entity.thrown = false;
            }
          }
          entity.x += entity.vx * delta;
          entity.y += entity.vy * delta;
          if (entity.x < bounds.left) {
            entity.x = bounds.left;
            entity.vx =
              Math.abs(entity.vx) * (entity.thrown ? wallBounce : 1);
            entity.direction = 1;
          }
          const rightLimit = Math.max(bounds.left, bounds.right - width);
          if (entity.x > rightLimit) {
            entity.x = rightLimit;
            entity.vx =
              -Math.abs(entity.vx) * (entity.thrown ? wallBounce : 1);
            entity.direction = -1;
          }
          if (entity.y < 0) {
            entity.y = 0;
            entity.vy =
              Math.abs(entity.vy) * (entity.thrown ? groundBounce : 1);
            entity.directionY = 1;
          }
          const bottomLimit = bounds.floor - height;
          if (entity.y > bottomLimit) {
            entity.y = bottomLimit;
            entity.vy =
              -Math.abs(entity.vy) * (entity.thrown ? groundBounce : 1);
            entity.directionY = -1;
          }
          if (
            overlaySettings.idleActionEnabled &&
            now >= entity.nextIdleAt
          ) {
            const seconds = Math.max(
              5,
              Number(overlaySettings.idleActionIntervalSeconds || 20)
            );
            entity.nextIdleAt = now + seconds * 1000;
            if (Math.random() * 100 < overlaySettings.idleActionChance) {
              entity.vx = 0;
              entity.vy = 0;
              entity.idleUntil = now + idleActionDurationRef.current;
            }
          }
          setEntityDirection(entity.direction);
          setEntityVisual("walk");
        }
      } else {
        const previousBottom = entity.y + height;
        const wasGroundedBeforeStep = entity.grounded;
        if (entity.thrown && friction > 0) {
          const amount = Math.pow(friction, 1.45) * 520 * delta;
          if (Math.abs(entity.vx) <= amount) entity.vx = 0;
          else entity.vx -= Math.sign(entity.vx) * amount;
        }
        if (entity.grounded && entity.supportY !== null) {
          entity.vy = 0;
        } else {
          entity.vy += Number(overlaySettings.gravity || 1800) * delta;
        }
        entity.x += entity.vx * delta;
        entity.y += entity.vy * delta;

        if (entity.x < bounds.left) {
          entity.x = bounds.left;
          entity.vx =
            Math.abs(entity.vx) * (entity.thrown ? wallBounce : 1);
          entity.direction = 1;
          setEntityDirection(1);
        }
        const rightLimit = Math.max(bounds.left, bounds.right - width);
        if (entity.x > rightLimit) {
          entity.x = rightLimit;
          entity.vx =
            -Math.abs(entity.vx) * (entity.thrown ? wallBounce : 1);
          entity.direction = -1;
          setEntityDirection(-1);
        }

        let lockedSupportY: number | null = null;
        if (entity.grounded && entity.supportY !== null) {
          const trackedSurface =
            entity.supportId && entity.supportId !== "floor"
              ? supportSurfaces.find(
                  (surface) => surface.id === entity.supportId
                )
              : null;
          if (
            entity.supportId &&
            entity.supportId !== "floor" &&
            !trackedSurface
          ) {
            entity.grounded = false;
            entity.supportY = null;
            entity.supportLeft = null;
            entity.supportRight = null;
            entity.supportId = null;
            entity.supportGraceUntil = 0;
          } else {
            if (trackedSurface) {
              entity.y = trackedSurface.y - height;
              entity.supportY = trackedSurface.y;
              entity.supportLeft = trackedSurface.x;
              entity.supportRight = trackedSurface.x + trackedSurface.width;
              lockedSupportY = trackedSurface.y;
            }
            const footLeft = entity.x + width * 0.36;
            const footRight = entity.x + width * 0.64;
            const stillSupported =
              entity.supportLeft !== null &&
              entity.supportRight !== null &&
              footRight > entity.supportLeft + 2 &&
              footLeft < entity.supportRight - 2;
            if (!stillSupported && entity.supportY !== bounds.floor) {
              if (now < entity.supportGraceUntil) {
                lockedSupportY = entity.supportY;
              } else {
                entity.grounded = false;
                entity.supportY = null;
                entity.supportLeft = null;
                entity.supportRight = null;
                entity.supportId = null;
                entity.supportGraceUntil = 0;
              }
            } else if (stillSupported && entity.supportY !== bounds.floor) {
              lockedSupportY = entity.supportY;
              entity.supportGraceUntil = now + 140;
            }
          }
        }

        const newBottom = entity.y + height;
        const landingIcon =
          lockedSupportY === null && entity.vy >= 0
            ? supportSurfaces
                .filter(
                  (icon) =>
                    icon.y >= previousBottom - 6 &&
                    icon.y <= newBottom + 6 &&
                    entity.x + width * 0.64 > icon.x + 2 &&
                    entity.x + width * 0.36 <
                      icon.x + icon.width - 2
                )
                .sort((left, right) => left.y - right.y)[0]
            : undefined;
        if (lockedSupportY === null && !landingIcon) {
          requestAirborneFallback(entity, now);
        }
        const floorY = bounds.floor - height;
        if (lockedSupportY !== null) {
          entity.y = lockedSupportY - height;
          entity.vy = 0;
          entity.grounded = true;
          entity.fallbackRequested = false;
          updateGroundedBehavior(entity, now, false);
        } else if (landingIcon && landingIcon.y <= bounds.floor) {
          const wasFalling =
            !wasGroundedBeforeStep && Math.abs(entity.vy) > 80;
          entity.y = landingIcon.y - height;
          entity.vy = 0;
          entity.grounded = true;
          entity.fallbackRequested = false;
          entity.supportY = landingIcon.y;
          entity.supportLeft = landingIcon.x;
          entity.supportRight = landingIcon.x + landingIcon.width;
          entity.supportId = landingIcon.id || "";
          entity.supportGraceUntil = now + 140;
          updateGroundedBehavior(entity, now, wasFalling);
        } else if (entity.y >= floorY) {
          const impactSpeed = Math.abs(entity.vy);
          const wasFalling = entity.vy > 100;
          entity.y = floorY;
          if (entity.thrown && groundBounce > 0 && impactSpeed > 120) {
            entity.vy = -impactSpeed * groundBounce * 0.55;
            entity.grounded = false;
            setEntityVisual("fall");
          } else {
            entity.vy = 0;
            entity.grounded = true;
            entity.fallbackRequested = false;
            entity.supportY = bounds.floor;
            entity.supportLeft = bounds.left;
            entity.supportRight = bounds.right;
            entity.supportId = "floor";
            entity.supportGraceUntil = 0;
            climbGiveUpUntilRef.current = 0;
            climbChainActiveRef.current = false;
            climbChainStepsRef.current = 0;
            climbChainHeightRef.current = 0;
            climbApproachTargetIdRef.current = "";
            updateGroundedBehavior(entity, now, wasFalling);
          }
        } else {
          entity.grounded = false;
          if (entity.vy > 80) setEntityVisual("fall");
        }

        if (canInteract) {
          for (const other of registry.current.values()) {
            if (other.id === entity.id) continue;
            if (
              entity.passUntil > now ||
              other.passUntil > now ||
              !rectanglesOverlap(entity, other)
            ) {
              continue;
            }
            const pass =
              Math.random() * 100 < overlaySettings.passThroughChance;
            if (pass) {
              entity.passUntil = now + 650;
              other.passUntil = now + 650;
              setZIndex(20 + Math.floor(Math.random() * 20));
            } else {
              const directionSign = entity.x <= other.x ? -1 : 1;
              entity.vx = directionSign * Math.max(70, Math.abs(entity.vx));
              entity.direction = directionSign < 0 ? -1 : 1;
              setEntityDirection(entity.direction);
              entity.x += directionSign * 6;
            }
          }
        }
      }

      sync();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [
    bounds.left,
    bounds.right,
    bounds.floor,
    height,
    width,
    displayWidth,
    displayHeight,
    scale,
    desktopRenderConfig?.hitboxOffsetX,
    desktopRenderConfig?.hitboxOffsetY,
    overlaySettings,
    canInteract,
    zIndex,
    desktopIcons,
    supportSurfaces,
    iconSteps.x,
    iconSteps.y,
    climbModule
  ]);

  useEffect(() => {
    function finishOnBlur() {
      finishDragRef.current();
    }
    function finishWhenHidden() {
      if (document.visibilityState === "hidden") {
        finishDragRef.current();
      }
    }
    window.addEventListener("blur", finishOnBlur);
    document.addEventListener("visibilitychange", finishWhenHidden);
    return () => {
      window.removeEventListener("blur", finishOnBlur);
      document.removeEventListener("visibilitychange", finishWhenHidden);
      finishDragRef.current();
      registry.current.delete(pet.id);
    };
  }, [pet.id, registry]);

  useEffect(() => {
    if (typeof window.deskPet.onPetInput !== "function") return;
    const unsubscribe = window.deskPet.onPetInput((payload) => {
      if (payload.petId !== pet.id) return;
      const x = Number(payload.x);
      const y = Number(payload.y);
      const type = payload.type;
      const buttons =
        typeof payload.buttons === "number" ? payload.buttons : 1;

      if (isPetInputDown(type)) {
        if (typeof payload.button === "number" && payload.button !== 0) {
          return;
        }
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        beginInteractionDrag(x, y);
        return;
      }

      if (isPetInputMove(type)) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        updateDragPositionRef.current(x, y, buttons, "global");
        return;
      }

      if (isPetInputEnd(type)) {
        finishDragRef.current();
        return;
      }

      if (type === "contextmenu") {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        finishDragRef.current();
        setMenuOpen(true);
        return;
      }

      if (type === "dblclick") {
        void window.deskPet.showControl();
      }
    });
    return unsubscribe;
  }, [pet.id, width, height]);

  useEffect(() => {
    if (typeof window.deskPet.onGlobalDrag !== "function") return;
    const unsubscribe = window.deskPet.onGlobalDrag(({ x, y, buttons }) => {
      const session = dragSessionRef.current;
      if (!session?.globalMode) return;
      updateDragPositionRef.current(x, y, buttons, "global");
      if (buttons === 0) finishDragRef.current();
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    voicePhaseRef.current = voicePhase;
  }, [voicePhase]);

  useEffect(() => {
    const lines = pet.voiceLines;
        if (!autoVoiceEnabled || !lines?.enabled || !lines.clips?.length) {
        return;
      }
    const intervalMs =
      Math.max(5, Number(lines.intervalSeconds || 60)) * 1000;
    const probability = Math.max(
      0,
      Math.min(100, Number(lines.probability ?? 60))
    );
    if (!nextVoiceLineAtRef.current) {
      nextVoiceLineAtRef.current = performance.now() + intervalMs;
    }
    const timer = window.setInterval(() => {
      if (physics.current.dragging) return;
      if (voicePhaseRef.current !== "idle") return;
        if (
          textChatOpen ||
          externalChatOpen ||
          voiceChatOpen ||
          menuOpen ||
          autoReplyOpen ||
          autoReplyBusy ||
          voiceAudioSrc ||
          autoVoiceAudioSrc ||
          chatBusy ||
          isVoiceBusy
        ) {
          return;
        }
      const now = performance.now();
      if (now < nextVoiceLineAtRef.current) return;
      nextVoiceLineAtRef.current = now + intervalMs;
      if (Math.random() * 100 >= probability) return;
      const clip = lines.clips[Math.floor(Math.random() * lines.clips.length)];
      if (clip?.url) setVoiceAudioSrc(clip.url);
    }, 1000);
    return () => window.clearInterval(timer);
    }, [
      pet.voiceLines,
      autoVoiceEnabled,
      textChatOpen,
      externalChatOpen,
      voiceChatOpen,
      menuOpen,
      autoReplyOpen,
      autoReplyBusy,
      voiceAudioSrc,
      autoVoiceAudioSrc,
      chatBusy,
      isVoiceBusy
    ]);

  useEffect(() => {
    const unsubscribeAudio = window.deskPet.voiceAgent.onAudioChunk(
      (payload) => {
        if (
          payload.sessionId &&
          payload.sessionId !== voiceSessionKey(voiceSessionRef.current)
        ) {
          return;
        }
        setVoicePhase("speaking");
        enqueueVoiceChunk(payload.audioDataUrl);
        void startVoiceMonitor();
      }
    );
    const unsubscribeTranscript = window.deskPet.voiceAgent.onTranscript(
      (payload) => {
        if (
          payload.sessionId &&
          payload.sessionId !== voiceSessionKey(voiceSessionRef.current)
        ) {
          return;
        }
        setVoiceTranscript(payload.text);
      }
    );
    return () => {
      unsubscribeAudio();
      unsubscribeTranscript();
    };
  }, []);

  useEffect(
    () => () => {
      stopVoiceVad();
      stopVoiceMonitor();
    },
    []
  );

  useEffect(() => {
    const unsubscribe = window.deskPet.onOverlayCommand((command) => {
      const runtimeCommand = command as unknown as {
        type: string;
        petId?: string;
        locked?: boolean;
      };
      const commandPetId = runtimeCommand.petId;
      if (commandPetId && commandPetId !== pet.id) return;
      const entity = physics.current;
      const now = performance.now();
      if (runtimeCommand.type === "edit-lock") {
        const locked = Boolean(runtimeCommand.locked);
        setEditLocked(locked);
        entity.vx = 0;
        entity.vy = 0;
        if (locked && !entity.dragging) setEntityVisual("idle");
      } else if (command.type === "rest") {
        entity.vx = 0;
        entity.vy = 0;
        entity.grounded = true;
        entity.idleUntil = 0;
        entity.restingUntil = now + 24 * 60 * 60 * 1000;
        setEntityVisual("sleep");
      } else if (command.type === "home" || command.type === "show") {
        entity.x = bounds.left + (bounds.right - bounds.left) / 2 - width / 2;
        entity.y = bounds.floor - height;
        entity.vx = 0;
        entity.vy = 0;
        entity.grounded = true;
        entity.thrown = false;
        entity.dragging = false;
        entity.idleUntil = 0;
        entity.restingUntil = 0;
        entity.supportY = bounds.floor;
        entity.supportLeft = bounds.left;
        entity.supportRight = bounds.right;
        entity.supportId = "floor";
        entity.supportGraceUntil = 0;
        setEntityVisual("idle");
        sync();
      } else if (command.type === "drop") {
        entity.x = bounds.left + (bounds.right - bounds.left) / 2 - width / 2;
        entity.y = 40;
        entity.vx = 0;
        entity.vy = 180;
        entity.grounded = false;
        entity.thrown = true;
        entity.dragging = false;
        entity.idleUntil = 0;
        entity.restingUntil = 0;
        entity.supportY = null;
        entity.supportLeft = null;
        entity.supportRight = null;
        entity.supportId = null;
        entity.supportGraceUntil = 0;
        setEntityVisual("fall");
        sync();
      } else if (command.type === "walk") {
        entity.vx = effectiveWalkSpeed * entity.direction;
        entity.thrown = false;
        entity.idleUntil = 0;
        entity.restingUntil = 0;
        setEntityVisual("walk");
      }
    });
    return unsubscribe;
  }, [
    pet.id,
    bounds.left,
    bounds.right,
    bounds.floor,
    width,
    height,
    displayWidth,
    displayHeight,
    scale,
    desktopRenderConfig?.hitboxOffsetX,
    desktopRenderConfig?.hitboxOffsetY,
    effectiveWalkSpeed
  ]);

  useEffect(() => {
    if (!menuOpen) return;
    function handleOutsidePointer(event: PointerEvent) {
      const target = event.target as Node;
      if (
        menuRef.current?.contains(target) ||
        hitboxRef.current?.contains(target)
      ) {
        return;
      }
      setMenuOpen(false);
    }
    window.addEventListener("pointerdown", handleOutsidePointer);
    return () => window.removeEventListener("pointerdown", handleOutsidePointer);
  }, [menuOpen]);

  function detachLocalDragListeners(session: DragSession) {
    if (!session.localListenersAttached) return;
    window.removeEventListener("pointermove", session.pointerMove, true);
    window.removeEventListener("mousemove", session.mouseMove, true);
    window.removeEventListener("pointerup", session.pointerUp, true);
    window.removeEventListener("pointercancel", session.pointerCancel, true);
    window.removeEventListener("pointerleave", session.pointerLeave, true);
    session.localListenersAttached = false;
    try {
      if (session.captureElement.hasPointerCapture(session.pointerId)) {
        session.captureElement.releasePointerCapture(session.pointerId);
      }
    } catch {
      // The pointer may already be gone when the window loses focus.
    }
  }

  function attachLocalDragListeners(session: DragSession) {
    if (session.globalMode || session.localListenersAttached) return;
    window.addEventListener("pointermove", session.pointerMove, true);
    window.addEventListener("mousemove", session.mouseMove, true);
    window.addEventListener("pointerup", session.pointerUp, true);
    window.addEventListener("pointercancel", session.pointerCancel, true);
    window.addEventListener("pointerleave", session.pointerLeave, true);
    session.localListenersAttached = true;
    try {
      if (!session.captureElement.hasPointerCapture(session.pointerId)) {
        session.captureElement.setPointerCapture(session.pointerId);
      }
    } catch {
      // Window listeners still keep the fallback drag path usable.
    }
  }

  function clearDragSession() {
    const session = dragSessionRef.current;
    if (!session) return;
    detachLocalDragListeners(session);
    dragSessionRef.current = null;
  }

  function updateDragPosition(
    clientX: number,
    clientY: number,
    buttons: number,
    source: DragMoveSource
  ) {
    const session = dragSessionRef.current;
    const entity = physics.current;
    if (!session || !entity.dragging) {
      if (session) finishDragRef.current();
      return;
    }
    if (buttons === 0) {
      finishDragRef.current();
      return;
    }
    const now = performance.now();
    const lastMove = lastDragMoveRef.current;
    if (clientX === lastMove.x && clientY === lastMove.y) {
      lastMove.at = now;
      lastMove.source = source;
      return;
    }
    const dx = clientX - entity.lastPointerX;
    const dy = clientY - entity.lastPointerY;
    const delta = Math.max(8, now - entity.lastPointerAt);
    dragDistanceRef.current += Math.hypot(dx, dy);
    entity.vx = (dx / delta) * 720;
    entity.vy = (dy / delta) * 720;
    entity.x = clientX - entity.dragOffsetX;
    entity.y = clientY - entity.dragOffsetY;
    entity.lastPointerX = clientX;
    entity.lastPointerY = clientY;
    entity.lastPointerAt = now;
    lastDragMoveRef.current = { x: clientX, y: clientY, at: now, source };
    syncDragPositionRef.current();
  }

  updateDragPositionRef.current = updateDragPosition;

  function finishDrag() {
    const session = dragSessionRef.current;
    const entity = physics.current;
    if (!session && !entity.dragging) {
      dragVisualReadyAtRef.current = 0;
      lastDragMoveRef.current = {
        x: Number.NaN,
        y: Number.NaN,
        at: 0,
        source: "pointer"
      };
      overlayDragging = false;
      syncPanelClaims();
      return;
    }
    const usedGlobalDrag = Boolean(session?.globalMode);
    clearDragSession();
    if (
      usedGlobalDrag &&
      typeof window.deskPet.endGlobalDrag === "function"
    ) {
      void window.deskPet.endGlobalDrag().catch(() => undefined);
    }
    dragVisualReadyAtRef.current = 0;
    lastDragMoveRef.current = {
      x: Number.NaN,
      y: Number.NaN,
      at: 0,
      source: "pointer"
    };
    overlayDragging = false;
    syncPanelClaims();
    if (!entity.dragging) {
      dragDistanceRef.current = 0;
      return;
    }
    entity.dragging = false;
    const draggedDistance = dragDistanceRef.current;
    dragDistanceRef.current = 0;
    if (draggedDistance >= 8) onDragInteract();
    const centerX = entity.x + width / 2;
    const top = entity.y;
    const bottom = entity.y + height;
    const droppedSurface = [...supportSurfaces]
      .filter(
        (surface) =>
          centerX >= surface.x &&
          centerX <= surface.x + surface.width &&
          bottom >= surface.y - 8 &&
          top <= surface.y + surface.height + 8
      )
      .sort(
        (left, right) =>
          Math.abs(left.y - bottom) - Math.abs(right.y - bottom)
      )[0];
    if (droppedSurface) {
      entity.x = clamp(
        entity.x,
        droppedSurface.x,
        Math.max(
          droppedSurface.x,
          droppedSurface.x + droppedSurface.width - width
        )
      );
      entity.y = droppedSurface.y - height;
      entity.vx = 0;
      entity.vy = 0;
      entity.grounded = true;
      entity.supportY = droppedSurface.y;
      entity.supportLeft = droppedSurface.x;
      entity.supportRight = droppedSurface.x + droppedSurface.width;
      entity.supportId = droppedSurface.id || null;
      entity.supportGraceUntil = performance.now() + 140;
      entity.thrown = false;
      setEntityVisual("land");
      return;
    }
    entity.vx = clamp(entity.vx, -1200, 1200);
    entity.vy = clamp(entity.vy, -1000, 1400);
    entity.grounded = false;
    entity.direction = entity.vx < 0 ? -1 : 1;
    entity.directionY = entity.vy < 0 ? -1 : 1;
    entity.thrown = true;
    setEntityDirection(entity.direction);
    setEntityVisual("fall");
  }

  finishDragRef.current = finishDrag;

  function beginInteractionDrag(clientX: number, clientY: number) {
    if (dragSessionRef.current) finishDragRef.current();
    const entity = physics.current;
    dragDistanceRef.current = 0;
    entity.dragging = true;
    entity.dragOffsetX = clientX - entity.x;
    entity.dragOffsetY = clientY - entity.y;
    entity.lastPointerX = clientX;
    entity.lastPointerY = clientY;
    const startedAt = performance.now();
    entity.lastPointerAt = startedAt;
    entity.vx = 0;
    entity.vy = 0;
    entity.restingUntil = 0;
    climbChainActiveRef.current = false;
    climbChainStepsRef.current = 0;
    climbChainHeightRef.current = 0;
    climbApproachTargetIdRef.current = "";
    dragVisualReadyAtRef.current = startedAt + DRAG_VISUAL_DELAY_MS;
    lastDragMoveRef.current = {
      x: clientX,
      y: clientY,
      at: startedAt,
      source: "global"
    };
    overlayDragging = true;
    const captureElement = hitboxRef.current;
    if (!captureElement) {
      entity.dragging = false;
      overlayDragging = false;
      return;
    }
    dragSessionRef.current = {
      pointerId: -1,
      captureElement,
      globalMode: false,
      localListenersAttached: false,
      pointerMove: () => undefined,
      mouseMove: () => undefined,
      pointerUp: () => undefined,
      pointerCancel: () => undefined,
      pointerLeave: () => undefined
    };
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragSessionRef.current) finishDragRef.current();
    const entity = physics.current;
    const pointerId = event.pointerId;
    dragDistanceRef.current = 0;
    entity.dragging = true;
    entity.dragOffsetX = event.clientX - entity.x;
    entity.dragOffsetY = event.clientY - entity.y;
    entity.lastPointerX = event.clientX;
    entity.lastPointerY = event.clientY;
    const startedAt = performance.now();
    entity.lastPointerAt = startedAt;
    entity.vx = 0;
    entity.vy = 0;
    entity.restingUntil = 0;
    climbChainActiveRef.current = false;
    climbChainStepsRef.current = 0;
    climbChainHeightRef.current = 0;
    climbApproachTargetIdRef.current = "";
    dragVisualReadyAtRef.current = startedAt + DRAG_VISUAL_DELAY_MS;
    lastDragMoveRef.current = {
      x: event.clientX,
      y: event.clientY,
      at: startedAt,
      source: "pointer"
    };
    overlayDragging = true;

    const pointerMove = (nativeEvent: PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session || session.pointerId !== pointerId) return;
      updateDragPositionRef.current(
        nativeEvent.clientX,
        nativeEvent.clientY,
        nativeEvent.buttons,
        "pointer"
      );
    };
    const mouseMove = (nativeEvent: MouseEvent) => {
      const session = dragSessionRef.current;
      if (!session || session.pointerId !== pointerId) return;
      updateDragPositionRef.current(
        nativeEvent.clientX,
        nativeEvent.clientY,
        nativeEvent.buttons,
        "mouse"
      );
    };
    const pointerUp = (nativeEvent: PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session || session.pointerId !== pointerId) return;
      finishDragRef.current(nativeEvent);
    };
    const pointerCancel = (nativeEvent: PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session || session.pointerId !== pointerId) return;
      finishDragRef.current(nativeEvent);
    };
    const pointerLeave = (nativeEvent: PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session || session.pointerId !== pointerId) return;
      finishDragRef.current(nativeEvent);
    };
    const session: DragSession = {
      pointerId,
      captureElement: event.currentTarget,
      globalMode: false,
      localListenersAttached: false,
      pointerMove,
      mouseMove,
      pointerUp,
      pointerCancel,
      pointerLeave
    };
    dragSessionRef.current = session;
    attachLocalDragListeners(session);

    if (
      window.deskPet.globalDragSupported &&
      typeof window.deskPet.beginGlobalDrag === "function"
    ) {
      void window.deskPet
        .beginGlobalDrag()
        .then((result) => {
          if (!result.ok || !result.ready) return;
          const currentSession = dragSessionRef.current;
          if (
            currentSession !== session ||
            !physics.current.dragging
          ) {
            if (typeof window.deskPet.endGlobalDrag === "function") {
              void window.deskPet.endGlobalDrag().catch(() => undefined);
            }
            return;
          }
          detachLocalDragListeners(session);
          session.globalMode = true;
          applyOverlayMouseIgnore(true);
        })
        .catch(() => undefined);
    }
  }

  function clearAutoReplyTimer() {
    if (autoReplyTimerRef.current !== null) {
      window.clearInterval(autoReplyTimerRef.current);
      autoReplyTimerRef.current = null;
    }
  }

  function clearAutoReplyDismissTimer() {
    if (autoReplyDismissTimerRef.current !== null) {
      window.clearTimeout(autoReplyDismissTimerRef.current);
      autoReplyDismissTimerRef.current = null;
    }
  }

  function stopAutoReply() {
    autoReplyRequestRef.current += 1;
    clearAutoReplyTimer();
    clearAutoReplyDismissTimer();
    autoReplyBusyRef.current = false;
    setAutoReplyBusy(false);
    setAutoReplyOpen(false);
    setAutoReplyText("");
    setAutoVoiceAudioSrc("");
  }

  function showAutoReply(text: string, requestId: number) {
    if (!isMeaningfulDialogueText(text)) {
      stopAutoReply();
      return;
    }
    clearAutoReplyTimer();
    clearAutoReplyDismissTimer();
    const characters = Array.from(text);
    let index = 0;
    setAutoReplyText("");
    autoReplyTimerRef.current = window.setInterval(() => {
      if (autoReplyRequestRef.current !== requestId) {
        clearAutoReplyTimer();
        return;
      }
      index += 1;
      setAutoReplyText(characters.slice(0, index).join(""));
      if (index >= characters.length) {
        clearAutoReplyTimer();
        setChatMessages((current) => [
          ...current,
          { id: makeId("chat"), role: "assistant", content: text }
        ]);
        autoReplyDismissTimerRef.current = window.setTimeout(() => {
          autoReplyDismissTimerRef.current = null;
          stopAutoReply();
        }, 8000);
      }
    }, 45);
  }

  async function triggerAutoDialogue() {
    if (autoReplyBusyRef.current || !canAutoTalk) return;
    if (
      globalAutoTalkGate.busy ||
      Date.now() < globalAutoTalkGate.cooldownUntil
    ) {
      return;
    }
    globalAutoTalkGate.busy = true;
    const requestId = autoReplyRequestRef.current + 1;
    autoReplyRequestRef.current = requestId;
    autoReplyBusyRef.current = true;
    clearAutoReplyDismissTimer();
    setAutoReplyBusy(true);
    setAutoReplyOpen(true);
    setAutoReplyText("");
    setAutoVoiceAudioSrc("");
    try {
      const result = await window.deskPet.chat(
        [
          {
            role: "user",
            content:
              "现在没有人对你说话。请结合你当前的心情、精力、主动性和与用户的关系，主动开口说一句自然的话。不要提具体数值，不要解释设定，不要问“需要什么帮助”，控制在 1 到 2 句。"
          }
        ],
        pet.modulePlugins?.aiModuleId,
        pet.id
      );
      if (autoReplyRequestRef.current !== requestId) return;
      const text = String(result?.text || "").trim();
      if (!isMeaningfulDialogueText(text)) {
        stopAutoReply();
        return;
      }

      showAutoReply(text, requestId);
      if (canVoiceChat && autoVoiceEnabledRef.current) {
        const speech = await window.deskPet.voiceAgent.speak(text, {
          voiceProfileId: pet.modulePlugins?.voiceProfileId
        });
        if (
          autoReplyRequestRef.current === requestId &&
          autoVoiceEnabledRef.current &&
          speech.ok &&
          speech.audioDataUrl
        ) {
          setAutoVoiceAudioSrc(speech.audioDataUrl);
        }
      }
    } catch {
      if (autoReplyRequestRef.current === requestId) stopAutoReply();
    } finally {
      globalAutoTalkGate.busy = false;
      globalAutoTalkGate.cooldownUntil = Date.now() + 30000;
      if (autoReplyRequestRef.current === requestId) {
        autoReplyBusyRef.current = false;
        setAutoReplyBusy(false);
      }
    }
  }

  async function sendChatMessage() {
    const content = chatDraft.trim();
    if (!content || chatBusy) return;
    const userMessage = {
      id: makeId("chat"),
      role: "user" as const,
      content
    };
    const assistantId = makeId("chat");
    setChatMessages((current) => [
      ...current,
      userMessage,
      { id: assistantId, role: "assistant", content: "" }
    ]);
    setChatDraft("");
    setChatBusy(true);
    const requestId = makeId("chatreq");
    const unsubscribe = window.deskPet.onChatStream(
      ({ delta, requestId: incomingId }) => {
        if (!delta) return;
        if (incomingId && incomingId !== requestId) return;
        setChatMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? { ...message, content: `${message.content}${delta}` }
              : message
          )
        );
      }
    );
    try {
      const result = await window.deskPet.chatStream(
        [...chatMessages, userMessage].map((message) => ({
          role: message.role,
          content: message.content
        })),
        pet.modulePlugins?.aiModuleId,
          requestId,
          pet.id
      );
      setChatMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? { ...message, content: result.text }
            : message
        )
      );
    } finally {
      unsubscribe();
      setChatBusy(false);
    }
  }

  function playNextVoiceChunk() {
    const next = voiceQueueRef.current.shift();
    if (!next) {
      voicePlayingRef.current = false;
      return;
    }
    voicePlayingRef.current = true;
    setVoiceAudioSrc(next);
  }

  function enqueueVoiceChunk(url: string) {
    if (!url) return;
    voiceQueueRef.current.push(url);
    if (!voicePlayingRef.current) playNextVoiceChunk();
  }

  function clearVoiceQueue() {
    voiceQueueRef.current = [];
    voicePlayingRef.current = false;
    setVoiceAudioSrc("");
  }

  function stopVoiceVad() {
    if (voiceVadTimerRef.current !== null) {
      window.clearInterval(voiceVadTimerRef.current);
      voiceVadTimerRef.current = null;
    }
    const context = voiceAudioContextRef.current;
    voiceAudioContextRef.current = null;
    if (context) void context.close().catch(() => {});
    setVoiceLevel(0);
  }

  function startVoiceVad(stream: MediaStream) {
    stopVoiceVad();
    try {
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      voiceAudioContextRef.current = context;
      const data = new Uint8Array(analyser.fftSize);
      const startedAt = performance.now();
      let lastVoiceAt = 0;
      voiceVadTimerRef.current = window.setInterval(() => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const value of data) {
          const centered = (value - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / data.length);
        setVoiceLevel(Math.min(100, Math.round(rms * 320)));
        const now = performance.now();
        if (rms > 0.04) lastVoiceAt = now;
        // VAD 只负责显示音量，不再自动停止录音；录音由用户手动点击结束。
      }, 80);
    } catch {
      // 拿不到音频上下文时退回手动点击结束。
    }
  }

  function stopVoiceMonitor() {
    if (voiceMonitorTimerRef.current !== null) {
      window.clearInterval(voiceMonitorTimerRef.current);
      voiceMonitorTimerRef.current = null;
    }
    const context = voiceMonitorContextRef.current;
    voiceMonitorContextRef.current = null;
    if (context) void context.close().catch(() => {});
    const recorder = voiceMonitorRecorderRef.current;
    voiceMonitorRecorderRef.current = null;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // 已经停止时忽略。
      }
    }
    if (!voiceMonitorCaptureRef.current) {
      voiceMonitorStreamRef.current
        ?.getTracks()
        .forEach((track) => track.stop());
    }
    voiceMonitorStreamRef.current = null;
  }

  function handleVoiceToggle() {
    if (voicePhase === "recording") {
      stopVoiceChat();
    } else {
      void startVoiceChat();
    }
  }

  function closeVoiceChat() {
    voiceSessionRef.current += 1;
    if (voicePhase === "recording") stopVoiceChat();
    stopVoiceVad();
    stopVoiceMonitor();
    clearVoiceQueue();
    setVoicePhase("idle");
    setVoiceChatOpen(false);
  }

  async function handleBargeIn(stream: MediaStream) {
    voiceSessionRef.current += 1;
    clearVoiceQueue();
    if (voiceMonitorTimerRef.current !== null) {
      window.clearInterval(voiceMonitorTimerRef.current);
      voiceMonitorTimerRef.current = null;
    }
    const context = voiceMonitorContextRef.current;
    voiceMonitorContextRef.current = null;
    if (context) void context.close().catch(() => {});
    const recorder = voiceMonitorRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    const sessionId = voiceSessionRef.current + 1;
    voiceSessionRef.current = sessionId;
    voiceMonitorCaptureRef.current = true;
    voiceChunksRef.current = [...voiceMonitorTailRef.current];
    voiceMonitorTailRef.current = [];
    voiceRecorderRef.current = recorder;
    recorder.onstop = () => {
      stopVoiceVad();
      voiceMonitorCaptureRef.current = false;
      stream.getTracks().forEach((track) => track.stop());
      void processVoiceChat(sessionId);
    };
    voiceMonitorRecorderRef.current = null;
    voiceMonitorStreamRef.current = null;
    startVoiceVad(stream);
    setVoicePhase("recording");
  }

  async function startVoiceMonitor() {
    if (voiceMonitorRecorderRef.current || voiceMonitorStartingRef.current) return;
    voiceMonitorStartingRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      voiceMonitorStreamRef.current = stream;
      voiceMonitorCaptureRef.current = false;
      voiceMonitorTailRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (event) => {
        if (event.data.size === 0) return;
        if (voiceMonitorCaptureRef.current) {
          voiceChunksRef.current.push(event.data);
          return;
        }
        const tail = voiceMonitorTailRef.current;
        tail.push(event.data);
        while (tail.length > 2) tail.shift();
      };
      recorder.start(250);
      voiceMonitorRecorderRef.current = recorder;

      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      voiceMonitorContextRef.current = context;
      const data = new Uint8Array(analyser.fftSize);
      let hits = 0;
      voiceMonitorTimerRef.current = window.setInterval(() => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const value of data) {
          const centered = (value - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / data.length);
        if (rms > 0.06) hits += 1;
        else hits = Math.max(0, hits - 1);
        if (hits >= 3) {
          hits = 0;
          void handleBargeIn(stream);
        }
      }, 100);
    } catch {
      // 拿不到麦克风时不做打断，等它说完再继续。
    } finally {
      voiceMonitorStartingRef.current = false;
    }
  }

  async function startVoiceChat() {
    const sessionId = voiceSessionRef.current + 1;
    voiceSessionRef.current = sessionId;
    clearVoiceQueue();
    setVoiceTranscript("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      const recorder = new MediaRecorder(stream);
      voiceChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) voiceChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stopVoiceVad();
        stream.getTracks().forEach((track) => track.stop());
        void processVoiceChat(sessionId);
      };
      voiceRecorderRef.current = recorder;
      recorder.start();
      startVoiceVad(stream);
      setVoicePhase("recording");
      void window.deskPet.voiceAgent.warmup().catch(() => {});
    } catch (error) {
      window.alert(
        error instanceof Error ? error.message : "无法打开麦克风。"
      );
      setVoicePhase("idle");
    }
  }

  function stopVoiceChat() {
    const recorder = voiceRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
  }

  async function processVoiceChat(sessionId: number) {
    if (sessionId !== voiceSessionRef.current) return;
    if (!voiceChunksRef.current.length) {
      setVoicePhase("idle");
      return;
    }
    try {
      const blob = new Blob(voiceChunksRef.current, {
        type: voiceChunksRef.current[0]?.type || "audio/webm"
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      setVoicePhase("transcribing");
      const result = await window.deskPet.voiceAgent.turnStream(bytes, {
        aiModuleId: pet.modulePlugins?.aiModuleId,
        voiceProfileId: pet.modulePlugins?.voiceProfileId,
          sessionId: voiceSessionKey(sessionId),
          petId: pet.id
      });
      if (sessionId !== voiceSessionRef.current) return;
      if (!result.ok) {
        throw new Error(result.error || "语音对话失败。");
      }
      const waitForPlayback = () => {
        if (sessionId !== voiceSessionRef.current) return;
        if (voicePlayingRef.current || voiceQueueRef.current.length > 0) {
          window.setTimeout(waitForPlayback, 150);
          return;
        }
        stopVoiceMonitor();
        setVoicePhase("idle");
      };
      waitForPlayback();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "语音对话失败。");
      setVoicePhase("idle");
    }
  }

  return (
    <div ref={hostRef} className="multi-pet-entity" style={{ zIndex }}>
      <div
        ref={visualRef}
        className={`multi-pet-visual ${
          direction < 0 ? "multi-pet-visual--left" : ""
        }`}
      >
        {pet.spine ? (
          <SpinePet
            skelUrl={pet.spine.skelUrl}
            state={visualState}
            actionBindings={pet.actionBindings}
            boneMap={pet.boneMap}
            fitWidth={visualWidth}
            fitHeight={visualHeight}
            displayWidth={displayWidth}
            displayHeight={displayHeight}
            fitRatio={1}
            offsetX={(desktopRenderConfig?.offsetX || 0) * scale}
            offsetY={(desktopRenderConfig?.offsetY || 0) * scale}
            anchorBottom={false}
            normalizeBodySize={false}
            speedMultiplier={animationSpeed}
            className="multi-pet-spine"
            onAnimationData={(items) => {
              const names = items.map((item) => item.name);
              const durations = Object.fromEntries(
                items.map((item) => [item.name, item.duration])
              );
              const idleName = chooseBoundAnimation(
                "idle",
                pet.actionBindings,
                names,
                durations
              );
              const idleItem =
                items.find((item) => item.name === idleName) ||
                ["Special", "Relax", "Sit", "Idle", "Default"]
                  .map((candidate) =>
                    items.find(
                      (item) =>
                        item.name.toLowerCase() === candidate.toLowerCase()
                    )
                  )
                  .find(Boolean);
              if (idleItem && idleItem.duration > 0) {
                idleActionDurationRef.current = Math.max(
                  1000,
                  idleItem.duration * 1000
                );
              }
            }}
            fallback={
              <PetAvatar
                primary={pet.accent}
                secondary={pet.secondary}
                size={92 * scale}
                state={visualState}
                facing={direction < 0 ? "left" : "right"}
              />
            }
          />
        ) : (
          <PetAvatar
            primary={pet.accent}
            secondary={pet.secondary}
            size={92 * scale}
            state={visualState}
            facing={direction < 0 ? "left" : "right"}
          />
        )}
      </div>
      <div
        ref={hitboxRef}
        className="multi-pet-hitbox"
        data-pet-id={pet.id}
        style={{ pointerEvents: "none" }}
        onPointerDown={onPointerDown}
        onDoubleClick={() => window.deskPet.showControl()}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuOpen(true);
        }}
      />
      {foodNotice ? (
        <div className="pet-hunger-bubble pet-hunger-bubble--notice">
          {foodNotice}
        </div>
      ) : null}
      {!foodNotice &&
        voiceChatOpen &&
        createPortal(
          <div
            ref={voiceIndicatorRef}
            className="pet-voice-indicator pet-voice-indicator--portal"
            style={{
              left: voiceIndicatorPosition.left,
              top: voiceIndicatorPosition.top,
              zIndex: panelZ
            }}
            onPointerDown={promotePanel}
          >
            <button
              type="button"
              disabled={isVoiceBusy}
              onClick={handleVoiceToggle}
            >
              <Mic size={15} />
              {voicePhase === "recording"
                ? `正在录音 ${voiceLevel}%（点击结束录音）`
                : voicePhase === "transcribing"
                  ? "正在识别..."
                  : voicePhase === "thinking"
                    ? "正在思考..."
                    : voicePhase === "speaking"
                      ? "正在说话..."
                      : "点击说话"}
            </button>
            <button
              type="button"
              title="关闭语音对话"
              onClick={closeVoiceChat}
            >
              <X size={13} />
            </button>
          </div>,
          document.body
        )}
      {voiceAudioSrc && (
        <audio
          src={voiceAudioSrc}
          autoPlay
          onEnded={() => {
            setVoiceAudioSrc("");
            playNextVoiceChunk();
          }}
          onError={() => {
            setVoiceAudioSrc("");
            playNextVoiceChunk();
          }}
        />
      )}
      {autoVoiceAudioSrc && (
        <audio
          src={autoVoiceAudioSrc}
          autoPlay
          onEnded={() => setAutoVoiceAudioSrc("")}
          onError={() => setAutoVoiceAudioSrc("")}
        />
      )}
      {autoReplyOpen &&
        createPortal(
          <section
            ref={autoBubbleRef}
            className="pet-chat-bubble pet-chat-bubble--auto pet-chat-bubble--portal"
            style={{
              left: autoBubblePosition.left,
              top: autoBubblePosition.top,
              zIndex: panelZ,
              background: dialogModule?.background || "#f7f5ef",
              backgroundImage: dialogModule?.backgroundImageUrl
                ? `url("${dialogModule.backgroundImageUrl}")`
                : undefined,
              backgroundSize: "cover",
              backgroundPosition: "center",
              borderColor: dialogModule?.borderColor || "#d9d7d0",
              borderRadius: dialogModule?.borderRadius ?? 8,
              color: dialogModule?.textColor || "#172033",
              fontFamily: dialogModule?.fontFamily || "Microsoft YaHei UI"
            }}
            onPointerDown={promotePanel}
          >
            <header>
              <strong>{pet.name}</strong>
              <button type="button" onClick={stopAutoReply}>
                <X size={14} />
              </button>
            </header>
            <div className="pet-chat-messages">
              <div className="pet-chat-line pet-chat-line--assistant">
                {autoReplyText || (autoReplyBusy ? "正在想..." : "")}
              </div>
            </div>
          </section>,
          document.body
        )}
      {textChatOpen &&
        createPortal(
          <section
            ref={textBubbleRef}
            className="pet-chat-bubble pet-chat-bubble--portal"
            style={{
              left: textBubblePosition.left,
              top: textBubblePosition.top,
              zIndex: panelZ,
              background: dialogModule?.background || "#f7f5ef",
              backgroundImage: dialogModule?.backgroundImageUrl
                ? `url("${dialogModule.backgroundImageUrl}")`
                : undefined,
              backgroundSize: "cover",
              backgroundPosition: "center",
              borderColor: dialogModule?.borderColor || "#d9d7d0",
              borderRadius: dialogModule?.borderRadius ?? 8,
              color: dialogModule?.textColor || "#172033",
              fontFamily:
                dialogModule?.fontFamily || "Microsoft YaHei UI"
            }}
            onPointerDown={promotePanel}
          >
            <header>
              <strong>{pet.name}</strong>
              <button type="button" onClick={() => setTextChatOpen(false)}>
                <X size={14} />
              </button>
            </header>
            <div className="pet-chat-messages">
              {chatMessages.slice(-6).map((message) => (
                <div
                  className={`pet-chat-line pet-chat-line--${message.role}`}
                  key={message.id}
                  style={{
                    backgroundImage:
                      message.role === "user"
                        ? dialogModule?.userBubbleImageUrl
                          ? `url("${dialogModule.userBubbleImageUrl}")`
                          : undefined
                        : dialogModule?.assistantBubbleImageUrl
                          ? `url("${dialogModule.assistantBubbleImageUrl}")`
                          : undefined,
                    backgroundSize: "cover",
                    backgroundPosition: "center"
                  }}
                >
                  {message.content}
                </div>
              ))}
              {chatMessages.length === 0 && <span>说点什么吧。</span>}
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void sendChatMessage();
              }}
            >
              <input
                value={chatDraft}
                onChange={(event) => setChatDraft(event.target.value)}
                onFocus={promotePanel}
                placeholder="输入消息..."
              />
              <button type="submit" disabled={chatBusy || !chatDraft.trim()}>
                <Send size={14} />
              </button>
            </form>
          </section>,
          document.body
        )}
      {menuOpen &&
        createPortal(
          <div
            ref={menuRef}
            className="overlay-menu multi-pet-menu multi-pet-menu--portal"
            style={{
              left: menuPosition.left,
              top: menuPosition.top,
              zIndex: panelZ
            }}
            onPointerDown={promotePanel}
          >
          <button
            className="close-menu-button"
            type="button"
            onClick={() => setMenuOpen(false)}
          >
            <X size={16} />
            关闭
          </button>
          {hungerModule && (
            <div className="overlay-menu-status">
              <span>饥饿值</span>
              <strong>{Math.round(hunger)}%</strong>
            </div>
          )}
          {canTextChat && (
            <button
              type="button"
              onClick={() => {
                stopAutoReply();
                setVoiceAudioSrc("");
                if (voiceChatOpen) closeVoiceChat();
                setMenuOpen(false);
                setTextChatOpen(false);
                if (typeof window.deskPet.openChat !== "function") {
                  window.alert("当前版本的聊天窗口接口尚未就绪。");
                  return;
                }
                const anchor = {
                  petId: pet.id,
                  x: physics.current.x,
                  y: physics.current.y,
                  width: physics.current.width,
                  height: physics.current.height,
                  visible: true
                };
                setExternalChatOpen(true);
                void window.deskPet
                  .openChat("text", dialogModule?.id || "", anchor)
                  .then((opened) => {
                    if (!opened) {
                      setExternalChatOpen(false);
                      return;
                    }
                    setPanelZ(nextPanelZIndex());
                  })
                  .catch(() => {
                    setExternalChatOpen(false);
                    window.alert("完整文字对话窗口暂时无法打开。");
                  });
              }}
            >
              <MessageCircle size={16} />
              文字对话
            </button>
          )}
          {canVoiceChat && (
            <button
              type="button"
              onClick={() => {
                if (!voiceHasAi) {
                    window.alert(
                      "这个桌宠还没有绑定角色档案。请先在 ArkPet 里给它选择一个角色档案，再使用语音对话。"
                    );
                  return;
                }
                  stopAutoReply();
                  setVoiceAudioSrc("");
                setTextChatOpen(false);
                setVoiceChatOpen(true);
                setVoicePhase("idle");
                void window.deskPet.voiceAgent.warmup().catch(() => {});
                setMenuOpen(false);
              }}
            >
              <Mic size={16} />
              语音对话
            </button>
          )}
          {boundModules
            .filter((module) => module.builtinType !== "hunger-food")
            .map((module) => (
              <button
                type="button"
                key={module.id}
                onClick={() => {
                  if (module.builtinType === "climb-platforms") {
                    void window.deskPet.triggerExternalModule(module.id, pet.id);
                  } else if (!module.entry) {
                    window.alert("这个内置对话框模组没有可打开的外部页面。");
                  } else {
                    void window.deskPet.openExternalModule(module.id);
                  }
                  setMenuOpen(false);
                }}
              >
                <Puzzle size={16} />
                {module.contextMenuLabel || module.name}
              </button>
            ))}
          <button
            type="button"
            onClick={() => {
              void window.deskPet.overlayCommand({ type: "rest", petId: pet.id });
              setMenuOpen(false);
            }}
          >
            <Moon size={16} />
            桌面休眠
          </button>
          <button
            type="button"
            onClick={() => {
              void window.deskPet.overlayCommand({ type: "sleep", petId: pet.id });
              setMenuOpen(false);
            }}
          >
            <Power size={16} />
            收回并休眠
          </button>
          </div>,
          document.body
        )}
    </div>
  );
}

function rectanglesOverlap(left: EntitySnapshot, right: EntitySnapshot) {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}
