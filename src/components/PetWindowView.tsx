import { MessageCircle, Mic, Moon, Power, X } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";
import { resolveDialogModule } from "../lib/dialogModules";
import { clamp } from "../lib/format";
import { ensurePetVitals } from "../lib/petVitals";
import {
  getLayoutBoxPosition,
  getVisualSize,
  resolvePetLayout
} from "../lib/renderConfig";
import { recordPhysicalInteraction } from "../lib/wellbeing";
import { useAppState } from "../state";
import type {
  AppSettings,
  PetDesktopLayout,
  PetProfile,
  PetWindowInitPayload,
  PetWindowMetrics,
  PetWindowPeer,
  PetWindowRect
} from "../types";
import { PetAvatar } from "./PetAvatar";
import { SpinePet } from "./SpinePet";

/**
 * 每角色窗口（?view=pet-window&petId=...）的单宠视图。
 *
 * 与旧的全屏 overlay 的关键差别：
 * - 渲染进程只负责一只角色，窗口本身由主进程摆到目标位置；
 * - 唯一物理身体是碰撞体积，窗口左上角 = 碰撞体世界坐标 - `collisionInWindow`；
 * - 每帧通过 `pet-window:target` 上报窗口目标位置（主进程走原生 SetWindowPos）；
 * - 窗口比可点区域大，交互范围之外必须点击穿透；
 * - 显示框位置固定，只有碰撞体积 / 交互范围随朝向水平镜像。
 *
 * 契约见 prototypes/pet-window-runtime/PHASE3-TASKS.md。
 */

type Direction = 1 | -1;
type VisualState = "idle" | "walk" | "fall" | "land" | "drag" | "sleep";

type WindowGeometry = {
  windowSize: { w: number; h: number };
  /** 显示框在窗口内的位置与尺寸（窗口坐标） */
  frame: PetWindowRect;
  /** 碰撞体积在窗口内的位置与尺寸（窗口坐标），也是唯一物理身体 */
  collision: PetWindowRect;
  /** 交互范围在窗口内的位置与尺寸（窗口坐标），只影响点击 */
  interaction: PetWindowRect;
};

type BodyState = {
  x: number;
  y: number;
  w: number;
  h: number;
  grounded: boolean;
  supportY: number | null;
  supportLeft: number | null;
  supportRight: number | null;
};

type DragState = {
  active: boolean;
  pointerId: number;
  offsetX: number;
  offsetY: number;
  lastX: number;
  lastY: number;
  lastAt: number;
  distance: number;
};

const IDLE_ACTION_DURATION_MS = 2600;
const DRAG_CLICK_DISTANCE_PX = 8;
const TARGET_EPSILON = 1;
const MOUSE_HIT_INTERVAL_MS = 120;

function finiteNumber(value: unknown, fallback: number) {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed)
    ? parsed
    : fallback;
}

function normalizeRect(
  value: Partial<PetWindowRect> | null | undefined,
  fallback: PetWindowRect
): PetWindowRect {
  // 主进程线上格式同时带 w/h，读取时以 width/height 优先。
  return {
    x: finiteNumber(value?.x, fallback.x),
    y: finiteNumber(value?.y, fallback.y),
    width: Math.max(
      1,
      finiteNumber(value?.width, finiteNumber(value?.w, fallback.width))
    ),
    height: Math.max(
      1,
      finiteNumber(value?.height, finiteNumber(value?.h, fallback.height))
    )
  };
}

/** `pet-window:metrics` 载荷归一化：bounds / workArea / taskbar 全部为物理像素。 */
function normalizeMetrics(
  value: Partial<PetWindowMetrics> | null | undefined
): PetWindowMetrics | null {
  if (!value?.bounds) return null;
  const zero: PetWindowRect = { x: 0, y: 0, width: 1, height: 1 };
  const bounds = normalizeRect(value.bounds, zero);
  return {
    bounds,
    workArea: normalizeRect(value.workArea, bounds),
    taskbar: value.taskbar ? normalizeRect(value.taskbar, zero) : null
  };
}

function rectUnion(rects: PetWindowRect[]): PetWindowRect {
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function shiftRect(rect: PetWindowRect, dx: number, dy: number): PetWindowRect {
  return { ...rect, x: rect.x + dx, y: rect.y + dy };
}

/** 相对某个水平轴做镜像，用于「朝左 / 朝右时两个矩形一起镜像」。 */
function mirrorRectAboutX(rect: PetWindowRect, pivotX: number): PetWindowRect {
  return { ...rect, x: pivotX * 2 - (rect.x + rect.width) };
}

function rectsOverlap(left: PetWindowRect, right: PetWindowRect) {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function bodyRect(body: BodyState): PetWindowRect {
  return { x: body.x, y: body.y, width: body.w, height: body.h };
}

/**
 * 窗口几何 = union(displayFrame, collision, interaction) 的包围盒。
 * 两个方向都算一遍再取并集，避免朝左朝右时窗口尺寸反复变化。
 */
function geometryFromLayout(
  layout: PetDesktopLayout,
  scale: number
): Record<Direction, WindowGeometry> {
  const frameWidth = Math.max(1, layout.displayFrame.width * scale);
  const frameHeight = Math.max(1, layout.displayFrame.height * scale);
  const boxInFrame = (
    box: PetDesktopLayout["collision"],
    direction: Direction
  ): PetWindowRect => {
    const position = getLayoutBoxPosition(
      layout.displayFrame,
      box,
      direction
    );
    return {
      x: position.left * scale,
      y: position.top * scale,
      width: Math.max(1, box.width * scale),
      height: Math.max(1, box.height * scale)
    };
  };

  const directions: Direction[] = [1, -1];
  const bbox = rectUnion(
    directions.map((direction) =>
      rectUnion([
        { x: 0, y: 0, width: frameWidth, height: frameHeight },
        boxInFrame(layout.collision, direction),
        boxInFrame(layout.interaction, direction)
      ])
    )
  );

  const result = {} as Record<Direction, WindowGeometry>;
  for (const direction of directions) {
    result[direction] = {
      windowSize: { w: bbox.width, h: bbox.height },
      frame: shiftRect(
        { x: 0, y: 0, width: frameWidth, height: frameHeight },
        -bbox.x,
        -bbox.y
      ),
      collision: shiftRect(boxInFrame(layout.collision, direction), -bbox.x, -bbox.y),
      interaction: shiftRect(
        boxInFrame(layout.interaction, direction),
        -bbox.x,
        -bbox.y
      )
    };
  }
  return result;
}

/**
 * 优先使用主进程下发的 `pet-window:init` 几何（窗口尺寸以主进程为准），
 * 再按规格把碰撞体积 / 交互范围围绕显示框中心水平镜像到另一个朝向。
 */
function geometryFromInit(
  payload: PetWindowInitPayload,
  layout: PetDesktopLayout,
  scale: number
): Record<Direction, WindowGeometry> {
  const frameWidth = Math.max(1, layout.displayFrame.width * scale);
  const frameHeight = Math.max(1, layout.displayFrame.height * scale);
  const frame: PetWindowRect = {
    x: finiteNumber(payload.frameOffsetInWindow?.x, 0),
    y: finiteNumber(payload.frameOffsetInWindow?.y, 0),
    width: frameWidth,
    height: frameHeight
  };
  const collision = normalizeRect(payload.collisionInWindow, frame);
  const interaction = normalizeRect(payload.interactionInWindow, collision);
  const windowSize = {
    w: Math.max(
      1,
      finiteNumber(payload.windowSize?.w, frame.width + frame.x)
    ),
    h: Math.max(
      1,
      finiteNumber(payload.windowSize?.h, frame.height + frame.y)
    )
  };
  const baseDirection: Direction =
    layout.placement.direction === -1 ? -1 : 1;
  const pivotX = frame.x + frame.width / 2;
  const base: WindowGeometry = {
    windowSize,
    frame,
    collision,
    interaction
  };
  const mirrored: WindowGeometry = {
    windowSize,
    frame,
    collision: mirrorRectAboutX(collision, pivotX),
    interaction: mirrorRectAboutX(interaction, pivotX)
  };
  return baseDirection === 1
    ? { 1: base, [-1]: mirrored }
    : { 1: mirrored, [-1]: base };
}

/** 拿不到任务栏矩形时，从工作区与屏幕的差值反推一条任务栏碰撞带。 */
function deriveTaskbar(
  bounds: PetWindowRect,
  workArea: PetWindowRect | null
): PetWindowRect | null {
  if (!workArea) return null;
  const bottomGap = bounds.y + bounds.height - (workArea.y + workArea.height);
  if (bottomGap > 1) {
    return {
      x: bounds.x,
      y: bounds.y + bounds.height - bottomGap,
      width: bounds.width,
      height: bottomGap
    };
  }
  const topGap = workArea.y - bounds.y;
  if (topGap > 1) {
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: topGap };
  }
  const leftGap = workArea.x - bounds.x;
  if (leftGap > 1) {
    return { x: bounds.x, y: bounds.y, width: leftGap, height: bounds.height };
  }
  const rightGap = bounds.x + bounds.width - (workArea.x + workArea.width);
  if (rightGap > 1) {
    return {
      x: bounds.x + bounds.width - rightGap,
      y: bounds.y,
      width: rightGap,
      height: bounds.height
    };
  }
  return null;
}

function nextAutoTalkDelayMs(initiative: number) {
  const normalized = clamp(Number(initiative || 0), 0, 100) / 100;
  const base = 300000 - normalized * 120000;
  return base + Math.random() * 120000;
}

function isMeaningfulDialogueText(value: string) {
  return (
    value.replace(
      /[\s，。！？、；：,.!?;:…"'“”‘’—\-（）()【】\[\]《》<>/\\|]+/g,
      ""
    ).length > 0
  );
}

export function PetWindowView({ petId }: { petId: string }) {
  const { state } = useAppState();
  const [init, setInit] = useState<PetWindowInitPayload | null>(null);
  const [metrics, setMetrics] = useState<PetWindowMetrics | null>(null);
  const [ready, setReady] = useState(false);
  const [visualState, setVisualState] = useState<VisualState>("idle");
  const [direction, setDirection] = useState<Direction>(1);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: 8, top: 8 });
  const [autoText, setAutoText] = useState("");
  const [cssScale, setCssScale] = useState(1);

  const pet: PetProfile | null =
    state?.pets.find((item) => item.id === petId) || null;
  const overlaySettings: AppSettings["overlay"] | null =
    state?.settings.overlay || null;
  const dialogModule = state ? resolveDialogModule(state) : null;

  // ---- refs：物理与事件处理只读 ref，避免高频渲染 ----
  const rootRef = useRef<HTMLDivElement | null>(null);
  const interactionRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<BodyState>({
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    grounded: false,
    supportY: null,
    supportLeft: null,
    supportRight: null
  });
  const velocityRef = useRef({ vx: 0, vy: 0 });
  const directionRef = useRef<Direction>(1);
  const visualRef = useRef<VisualState>("idle");
  const geometryRef = useRef<Record<Direction, WindowGeometry> | null>(null);
  const metricsRef = useRef<PetWindowMetrics | null>(null);
  const unitsPerDipRef = useRef(1);
  const peersRef = useRef<PetWindowPeer[]>([]);
  // 第四阶段的模组平台（只提供顶面站立）：本阶段只订阅、不做物理。
  const platformsRef = useRef<Array<{ id: string; rect: PetWindowRect }>>([]);
  const encountersRef = useRef(new Map<string, "pass" | "block">());
  const overlayScaleRef = useRef({
    gravity: 1800,
    walkSpeed: 63,
    idleActionEnabled: true,
    idleActionIntervalSeconds: 20,
    idleActionChance: 45,
    passThroughChance: 30,
    gravityLocked: false
  });
  const targetRef = useRef({ x: Number.NaN, y: Number.NaN });
  const mouseIgnoreRef = useRef<boolean | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const forceInteractiveRef = useRef(false);
  const menuOpenRef = useRef(false);
  const nextIdleAtRef = useRef(0);
  const idleUntilRef = useRef(0);
  const nextDirectionAtRef = useRef(0);
  const readyReportedRef = useRef(false);
  const evaluateMouseRef = useRef<() => void>(() => undefined);
  const persistTimerRef = useRef<number | null>(null);
  const dragRef = useRef<DragState>({
    active: false,
    pointerId: -1,
    offsetX: 0,
    offsetY: 0,
    lastX: 0,
    lastY: 0,
    lastAt: 0,
    distance: 0
  });

  const layout = useMemo<PetDesktopLayout | null>(() => {
    if (!pet) return null;
    const payloadLayout =
      init?.layout && init.layout.layoutVersion === 3 ? init.layout : null;
    if (payloadLayout) return payloadLayout;
    return resolvePetLayout(
      pet.layout,
      pet.desktopRenderConfig || pet.renderConfig,
      pet.desktopPosition
    );
  }, [pet, init?.layout]);

  const scale = useMemo(() => {
    if (init && Number.isFinite(init.scale) && init.scale > 0) {
      return init.scale;
    }
    return (
      (finiteNumber(overlaySettings?.scale, 1) || 1) *
      (finiteNumber(pet?.scale, 1) || 1)
    );
  }, [init?.scale, overlaySettings?.scale, pet?.scale]);

  /** 逻辑几何：归一化布局 × scale，单位等于 CSS 像素。 */
  const logicalGeometry = useMemo(
    () => (layout ? geometryFromLayout(layout, scale) : null),
    [layout, scale]
  );

  /**
   * 物理像素 / 逻辑单位 的换算系数。主进程下发的窗口几何是物理像素，
   * 用「下发窗口宽度 ÷ 本地逻辑窗口宽度」反推，比只看 devicePixelRatio 更可靠。
   */
  const worldScale = useMemo(() => {
    const logicalWidth =
      logicalGeometry?.[1]?.windowSize.w ||
      logicalGeometry?.[-1]?.windowSize.w ||
      0;
    const physicalWidth = finiteNumber(init?.windowSize?.w, 0);
    if (logicalWidth > 1 && physicalWidth > 1) {
      const ratio = physicalWidth / logicalWidth;
      if (Number.isFinite(ratio) && ratio > 0.2 && ratio < 8) return ratio;
    }
    return window.devicePixelRatio || 1;
  }, [logicalGeometry, init?.windowSize?.w]);

  // ---- 通道订阅：init / metrics / peers / platforms ----
  useEffect(() => {
    if (!petId) return;
    const bridge = window.deskPet;
    const namespace = bridge.petWindow || {};
    const unsubscribers: Array<() => void> = [];
    const onInit = bridge.onPetWindowInit || namespace.onInit;
    const onMetrics = bridge.onPetWindowMetrics || namespace.onMetrics;
    const onPeers = bridge.onPetWindowPeers || namespace.onPeers;
    const onPlatforms = bridge.onPetWindowPlatforms || namespace.onPlatforms;
    const onSetIgnoreMouse =
      bridge.onPetWindowSetIgnoreMouse || namespace.onSetIgnoreMouse;
    if (typeof onInit === "function") {
      unsubscribers.push(
        onInit((payload) => {
          if (payload?.petId && payload.petId !== petId) return;
          setInit(payload);
          const nextMetrics = normalizeMetrics(payload?.metrics);
          if (nextMetrics) {
            metricsRef.current = nextMetrics;
            setMetrics(nextMetrics);
          }
        })
      );
    }
    if (typeof onMetrics === "function") {
      unsubscribers.push(
        onMetrics((payload) => {
          const next = normalizeMetrics(payload);
          if (!next) return;
          metricsRef.current = next;
          setMetrics(next);
        })
      );
    }
    if (typeof onPeers === "function") {
      unsubscribers.push(
        onPeers((payload) => {
          peersRef.current = Array.isArray(payload?.peers)
            ? payload.peers
            : [];
        })
      );
    }
    if (typeof onPlatforms === "function") {
      unsubscribers.push(
        onPlatforms((payload) => {
          platformsRef.current = Array.isArray(payload?.platforms)
            ? payload.platforms
                .filter((item) => item?.rect && Number.isFinite(item.rect.x))
                .map((item) => ({ id: String(item.id || ""), rect: item.rect }))
            : [];
        })
      );
    }
    if (typeof onSetIgnoreMouse === "function") {
      unsubscribers.push(
        onSetIgnoreMouse((payload) => {
          // 主进程回报实际生效的穿透状态，保持一致避免来回抖动。
          mouseIgnoreRef.current = Boolean(payload?.ignore);
          evaluateMouseRef.current();
        })
      );
    }
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [petId]);

  // ---- 兜底度量：拿不到 pet-window:metrics 时用显示器信息 + 工作区差值 ----
  // getDisplayMetrics 是 DIP，物理世界坐标要乘 devicePixelRatio。
  useEffect(() => {
    let mounted = true;
    void window.deskPet.getDisplayMetrics().then((next) => {
      if (!mounted || metricsRef.current) return;
      const factor = window.devicePixelRatio || 1;
      const bounds: PetWindowRect = {
        x: next.bounds.x * factor,
        y: next.bounds.y * factor,
        width: next.bounds.width * factor,
        height: next.bounds.height * factor
      };
      const workArea: PetWindowRect = {
        x: next.workArea.x * factor,
        y: next.workArea.y * factor,
        width: next.workArea.width * factor,
        height: next.workArea.height * factor
      };
      const fallback: PetWindowMetrics = {
        bounds,
        workArea,
        taskbar: deriveTaskbar(bounds, workArea)
      };
      metricsRef.current = fallback;
      setMetrics(fallback);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    function handleOutside(event: PointerEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (interactionRef.current?.contains(target)) return;
      setMenuOpen(false);
    }
    window.addEventListener("pointerdown", handleOutside, true);
    return () => window.removeEventListener("pointerdown", handleOutside, true);
  }, [menuOpen]);

  useEffect(() => {
    menuOpenRef.current = menuOpen;
    forceInteractiveRef.current = menuOpen || dragRef.current.active;
    if (!menuOpen) return;
    const element = menuRef.current;
    const width = element?.offsetWidth || 178;
    const height = element?.offsetHeight || 160;
    const rect = interactionRef.current?.getBoundingClientRect();
    const preferredLeft = rect ? rect.right + 8 : 8;
    const alternateLeft = rect ? rect.left - width - 8 : 8;
    const left =
      preferredLeft + width <= window.innerWidth - 4
        ? preferredLeft
        : alternateLeft;
    setMenuPosition({
      left: clamp(left, 4, Math.max(4, window.innerWidth - width - 4)),
      top: clamp(
        rect ? rect.top : 8,
        4,
        Math.max(4, window.innerHeight - height - 4)
      )
    });
  }, [menuOpen]);

  // ---- 几何 + 初始物理身体 ----
  useEffect(() => {
    if (!layout) return;
    const physicalScale = scale * worldScale;
    const geometry = init
      ? geometryFromInit(init, layout, physicalScale)
      : geometryFromLayout(layout, physicalScale);
    geometryRef.current = geometry;
    const current = geometry[directionRef.current] || geometry[1];
    const body = bodyRef.current;
    const nextWidth = current.collision.width;
    const nextHeight = current.collision.height;
    const sizeChanged = body.w !== nextWidth || body.h !== nextHeight;
    body.w = nextWidth;
    body.h = nextHeight;
    if (!ready || sizeChanged) {
      // placement 是碰撞体中心的屏幕坐标（逻辑单位），世界坐标是物理像素
      const placement = layout.placement;
      const bounds = metricsRef.current?.bounds;
      const originX = bounds?.x ?? 0;
      const originY = bounds?.y ?? 0;
      const centerX = Number.isFinite(placement?.x)
        ? originX + placement.x * worldScale
        : finiteNumber(pet?.desktopPosition?.x, 0) * worldScale + nextWidth / 2;
      const centerY = Number.isFinite(placement?.y)
        ? originY + placement.y * worldScale
        : finiteNumber(pet?.desktopPosition?.y, 0) * worldScale + nextHeight / 2;
      body.x = centerX - nextWidth / 2;
      body.y = centerY - nextHeight / 2;
      const initialDirection: Direction =
        layout.placement.direction === -1 ? -1 : 1;
      directionRef.current = initialDirection;
      setDirection(initialDirection);
      if (bounds) {
        body.x = clamp(
          body.x,
          bounds.x,
          Math.max(bounds.x, bounds.x + bounds.width - body.w)
        );
        const floorY = bounds.y + bounds.height - body.h;
        body.y = clamp(body.y, bounds.y, Math.max(bounds.y, floorY));
        if (Math.abs(body.y - floorY) < 2) {
          body.grounded = true;
          body.supportY = bounds.y + bounds.height;
          body.supportLeft = bounds.x;
          body.supportRight = bounds.x + bounds.width;
        }
      }
      const now = performance.now();
      nextIdleAtRef.current = now + 3000;
      nextDirectionAtRef.current = now + 4000;
      setReady(true);
    }
  }, [
    layout,
    init,
    scale,
    worldScale,
    ready,
    metrics,
    pet?.desktopPosition?.x,
    pet?.desktopPosition?.y
  ]);

  // ---- CSS 像素与世界单位（契约单位）的换算，按真实窗口尺寸自适应 ----
  useEffect(() => {
    function measure() {
      const geometry = geometryRef.current;
      const current = geometry?.[directionRef.current];
      const worldWidth = current?.windowSize.w || 0;
      if (worldWidth > 1 && window.innerWidth > 1) {
        const next = window.innerWidth / worldWidth;
        unitsPerDipRef.current = next;
        setCssScale(next);
      }
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [ready, direction, init, metrics, worldScale]);

  useEffect(() => {
    if (!ready || readyReportedRef.current) return;
    readyReportedRef.current = true;
    const bridge = window.deskPet;
    if (typeof bridge.petWindowReady === "function") {
      bridge.petWindowReady(petId);
    } else {
      bridge.petWindow?.ready?.(petId);
    }
  }, [ready, petId]);

  useEffect(() => {
    if (!overlaySettings) return;
    overlayScaleRef.current = {
      gravity: finiteNumber(overlaySettings.gravity, 1800),
      walkSpeed: finiteNumber(overlaySettings.walkSpeed, 63),
      idleActionEnabled: overlaySettings.idleActionEnabled !== false,
      idleActionIntervalSeconds: finiteNumber(
        overlaySettings.idleActionIntervalSeconds,
        20
      ),
      idleActionChance: finiteNumber(overlaySettings.idleActionChance, 45),
      passThroughChance: finiteNumber(overlaySettings.passThroughChance, 30),
      gravityLocked: overlaySettings.gravityLocked === true
    };
  }, [overlaySettings]);

  function getEffectiveWalkSpeed() {
    const configured = Math.max(
      1,
      finiteNumber(overlayScaleRef.current.walkSpeed, 63)
    );
    return 63 * Math.pow(configured / 63, 1.35);
  }

  function getAnimationSpeed() {
    const configured = Math.max(
      1,
      finiteNumber(overlayScaleRef.current.walkSpeed, 63)
    );
    return Math.min(4.5, Math.max(0.3, Math.pow(configured / 77, 1.25)));
  }

  function setVisual(next: VisualState) {
    if (visualRef.current === next) return;
    visualRef.current = next;
    setVisualState(next);
  }

  function setEntityDirection(next: Direction) {
    if (directionRef.current === next) return;
    directionRef.current = next;
    setDirection(next);
  }

  function sendTarget(x: number, y: number) {
    if (
      Math.abs(x - targetRef.current.x) < TARGET_EPSILON &&
      Math.abs(y - targetRef.current.y) < TARGET_EPSILON
    ) {
      return;
    }
    targetRef.current = { x, y };
    const bridge = window.deskPet;
    if (typeof bridge.petWindowTarget === "function") {
      bridge.petWindowTarget(petId, x, y);
      return;
    }
    if (typeof bridge.petWindow?.target === "function") {
      bridge.petWindow.target(petId, x, y);
      return;
    }
    // 后端尚未接通 pet-window:target 时退回已有通道（同样由主进程走原生移动）。
    if (typeof bridge.movePetWindow === "function") {
      void bridge.movePetWindow(petId, x, y).catch(() => undefined);
    }
  }

  function sendIgnoreMouse(ignore: boolean) {
    const bridge = window.deskPet;
    if (typeof bridge.petWindowIgnoreMouse === "function") {
      bridge.petWindowIgnoreMouse(petId, ignore);
      return;
    }
    bridge.petWindow?.ignoreMouse?.(petId, ignore);
  }

  function sendFocus(take: boolean) {
    const bridge = window.deskPet;
    if (typeof bridge.petWindowFocus === "function") {
      bridge.petWindowFocus(petId, take);
      return;
    }
    bridge.petWindow?.focus?.(petId, take);
  }

  function syncBodyToWindow() {
    const geometry = geometryRef.current;
    const current = geometry?.[directionRef.current];
    if (!current) return;
    const body = bodyRef.current;
    sendTarget(
      body.x - current.collision.x,
      body.y - current.collision.y
    );
  }

  function chooseRoamDirection(now: number) {
    if (now < nextDirectionAtRef.current) return;
    setEntityDirection(Math.random() > 0.5 ? 1 : -1);
    nextDirectionAtRef.current = now + 3500 + Math.random() * 12000;
  }

  /**
   * 物理步进：碰撞体积是唯一身体。
   * 屏幕四边与任务栏都是实心矩形，顶面可站、侧面阻挡；显示画面允许超出屏幕。
   */
  function stepPhysics(delta: number, now: number) {
    const metrics = metricsRef.current;
    const geometry = geometryRef.current;
    const body = bodyRef.current;
    const velocity = velocityRef.current;
    if (!metrics || !geometry) return;
    const current = geometry[directionRef.current];
    if (!current) return;

    const settings = overlayScaleRef.current;
    const bounds = metrics.bounds;
    const taskbar = metrics.taskbar;
    const dragging = dragRef.current.active;

    if (dragging) {
      setVisual("drag");
      syncBodyToWindow();
      return;
    }

    const walkSpeed = getEffectiveWalkSpeed();

    if (!settings.gravityLocked && !body.grounded) {
      velocity.vy += settings.gravity * delta;
    } else if (body.grounded) {
      velocity.vy = 0;
    }

    // 支撑判定：地面 / 任务栏顶面 / 模组平台（平台只提供顶面站立）
    if (body.grounded) {
      const floor = bounds.y + bounds.height;
      const footLeft = body.x + body.w * 0.36;
      const footRight = body.x + body.w * 0.64;
      const onFloor =
        body.supportY !== null && Math.abs(body.supportY - floor) < 2;
      const onTaskbar =
        Boolean(taskbar) &&
        body.supportY !== null &&
        Math.abs(body.supportY - (taskbar?.y ?? 0)) < 2;
      let stillSupported = onFloor;
      if (onTaskbar && taskbar) {
        stillSupported =
          footRight > taskbar.x + 2 &&
          footLeft < taskbar.x + taskbar.width - 2;
      } else if (
        !onFloor &&
        body.supportLeft !== null &&
        body.supportRight !== null
      ) {
        stillSupported =
          footRight > body.supportLeft + 2 &&
          footLeft < body.supportRight - 2;
      } else if (!onFloor && !onTaskbar) {
        stillSupported = false;
      }
      if (!stillSupported) {
        body.grounded = false;
        body.supportY = null;
        body.supportLeft = null;
        body.supportRight = null;
      }
    }

    // 行走 / 待机行为
    if (body.grounded) {
      if (idleUntilRef.current > now) {
        velocity.vx = 0;
        setVisual("idle");
      } else if (!settings.idleActionEnabled) {
        chooseRoamDirection(now);
        velocity.vx = walkSpeed * directionRef.current;
        setVisual("walk");
      } else if (now >= nextIdleAtRef.current && Math.abs(velocity.vx) < 4) {
        nextIdleAtRef.current =
          now + Math.max(5, settings.idleActionIntervalSeconds) * 1000;
        if (Math.random() * 100 < settings.idleActionChance) {
          velocity.vx = 0;
          idleUntilRef.current = now + IDLE_ACTION_DURATION_MS;
          setVisual("idle");
        } else {
          chooseRoamDirection(now);
          velocity.vx = walkSpeed * directionRef.current;
          setVisual("walk");
        }
      } else if (Math.abs(velocity.vx) < 4) {
        chooseRoamDirection(now);
        velocity.vx = walkSpeed * directionRef.current;
        setVisual("walk");
      } else {
        velocity.vx = walkSpeed * directionRef.current;
        setVisual("walk");
      }
    } else if (velocity.vy > 60) {
      setVisual("fall");
    }

    const previousBottom = body.y + body.h;
    body.x += velocity.vx * delta;
    body.y += velocity.vy * delta;

    // 屏幕四边：左右侧面阻挡、顶面阻挡
    if (body.x < bounds.x) {
      body.x = bounds.x;
      velocity.vx = Math.abs(velocity.vx);
      setEntityDirection(1);
    }
    const maxX = Math.max(bounds.x, bounds.x + bounds.width - body.w);
    if (body.x > maxX) {
      body.x = maxX;
      velocity.vx = -Math.abs(velocity.vx);
      setEntityDirection(-1);
    }
    if (body.y < bounds.y) {
      body.y = bounds.y;
      velocity.vy = Math.max(0, velocity.vy);
    }

    // 任务栏：完整实心矩形，顶面可站、侧面阻挡
    if (taskbar && rectsOverlap(bodyRect(body), taskbar)) {
      const overlapX =
        Math.min(body.x + body.w, taskbar.x + taskbar.width) -
        Math.max(body.x, taskbar.x);
      const overlapY =
        Math.min(body.y + body.h, taskbar.y + taskbar.height) -
        Math.max(body.y, taskbar.y);
      const fromAbove = previousBottom <= taskbar.y + 2;
      const bodyCenterY = body.y + body.h / 2;
      const taskbarCenterY = taskbar.y + taskbar.height / 2;
      if ((fromAbove || overlapY <= overlapX) && bodyCenterY <= taskbarCenterY) {
        body.y = taskbar.y - body.h;
        velocity.vy = 0;
        body.grounded = true;
        body.supportY = taskbar.y;
        body.supportLeft = taskbar.x;
        body.supportRight = taskbar.x + taskbar.width;
      } else if (overlapY <= overlapX) {
        body.y = taskbar.y + taskbar.height;
        velocity.vy = Math.max(0, velocity.vy);
        body.grounded = false;
        body.supportY = null;
        body.supportLeft = null;
        body.supportRight = null;
      } else if (body.x + body.w / 2 < taskbar.x + taskbar.width / 2) {
        body.x = taskbar.x - body.w;
        velocity.vx = -Math.abs(velocity.vx);
        setEntityDirection(-1);
      } else {
        body.x = taskbar.x + taskbar.width;
        velocity.vx = Math.abs(velocity.vx);
        setEntityDirection(1);
      }
    }

    // 屏幕底边：地面（平台优先，只做顶面碰撞）
    const floorY = bounds.y + bounds.height - body.h;
    if (!body.grounded) {
      const platform = findPlatformSupport(previousBottom, body.y + body.h);
      if (platform) {
        body.y = platform.rect.y - body.h;
        velocity.vy = 0;
        body.grounded = true;
        body.supportY = platform.rect.y;
        body.supportLeft = platform.rect.x;
        body.supportRight = platform.rect.x + platform.rect.width;
        setVisual("walk");
      } else if (body.y >= floorY) {
        const wasFalling = velocity.vy > 100;
        body.y = floorY;
        velocity.vy = 0;
        body.grounded = true;
        body.supportY = bounds.y + bounds.height;
        body.supportLeft = bounds.x;
        body.supportRight = bounds.x + bounds.width;
        setVisual(wasFalling ? "land" : "walk");
        schedulePersist();
      } else {
        setVisual("fall");
      }
    }

    // 多角色互撞：同一次相遇只判定一次
    resolvePeers();
    syncBodyToWindow();
  }

  /** 模组平台只提供顶面站立：从上方落下时停住，侧面接近不阻挡。 */
  function findPlatformSupport(previousBottom: number, nextBottom: number) {
    const bounds = metricsRef.current?.bounds;
    if (!bounds || !platformsRef.current.length) return null;
    const body = bodyRef.current;
    const footLeft = body.x + body.w * 0.36;
    const footRight = body.x + body.w * 0.64;
    return (
      platformsRef.current
        .filter((item) => {
          const rect = item.rect;
          return (
            rect.y >= previousBottom - 2 &&
            rect.y <= nextBottom + 2 &&
            rect.y >= bounds.y &&
            rect.y <= bounds.y + bounds.height &&
            footRight > rect.x + 2 &&
            footLeft < rect.x + rect.width - 2
          );
        })
        .sort((left, right) => left.rect.y - right.rect.y)[0] || null
    );
  }

  /**
   * 互撞规则（规格 §6）：用「相互穿过概率」判定一次。
   * 命中 → 允许碰撞体重叠、不主动改层级；未命中 → 只做「碰撞后反向」，不强制分离。
   */
  function resolvePeers() {
    const body = bodyRef.current;
    const velocity = velocityRef.current;
    const peers = peersRef.current;
    const encounters = encountersRef.current;
    if (!peers.length) {
      if (encounters.size) encounters.clear();
      return;
    }
    const stillTouching = new Set<string>();
    for (const peer of peers) {
      if (!peer?.petId || peer.petId === petId || !peer.rect) continue;
      const key = [petId, peer.petId].sort().join("|");
      const touching = rectsOverlap(bodyRect(body), peer.rect);
      if (!touching) {
        encounters.delete(key);
        continue;
      }
      stillTouching.add(key);
      if (encounters.has(key)) continue;
      const pass =
        Math.random() * 100 <
        clamp(overlayScaleRef.current.passThroughChance, 0, 100);
      encounters.set(key, pass ? "pass" : "block");
      if (pass) continue;
      const sign: Direction =
        body.x + body.w / 2 <= peer.rect.x + peer.rect.width / 2 ? -1 : 1;
      velocity.vx = sign * Math.max(70, Math.abs(velocity.vx));
      setEntityDirection(sign);
    }
    for (const key of Array.from(encounters.keys())) {
      if (!stillTouching.has(key)) encounters.delete(key);
    }
  }

  // ---- 物理主循环：每帧算碰撞体世界坐标并上报窗口目标 ----
  useEffect(() => {
    if (!ready) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const delta = Math.min(0.04, (now - previous) / 1000);
      previous = now;
      stepPhysics(delta, now);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // ---- 点击穿透：交互范围内可点，范围外一律穿透 ----
  useEffect(() => {
    if (!ready) return;
    const evaluate = () => {
      let hit = forceInteractiveRef.current;
      if (!hit) {
        const pointer = lastPointerRef.current;
        const element = interactionRef.current;
        if (pointer && element) {
          const top = document.elementFromPoint(pointer.x, pointer.y);
          hit = Boolean(
            top &&
              (element === top ||
                element.contains(top) ||
                menuRef.current?.contains(top))
          );
        }
      }
      const ignore = !hit;
      if (mouseIgnoreRef.current === ignore) return;
      mouseIgnoreRef.current = ignore;
      sendIgnoreMouse(ignore);
    };
    evaluateMouseRef.current = evaluate;
    const handleMove = (event: MouseEvent) => {
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
      evaluate();
    };
    window.addEventListener("mousemove", handleMove, true);
    const timer = window.setInterval(evaluate, MOUSE_HIT_INTERVAL_MS);
    evaluate();
    return () => {
      window.removeEventListener("mousemove", handleMove, true);
      window.clearInterval(timer);
      evaluateMouseRef.current = () => undefined;
    };
  }, [ready, petId]);

  // ---- 拖动：窗口跟随指针，所以用屏幕坐标换算世界坐标 ----
  function screenToWorld(screenX: number, screenY: number) {
    const originX = metricsRef.current?.bounds.x ?? 0;
    const originY = metricsRef.current?.bounds.y ?? 0;
    const factor = unitsPerDipRef.current || 1;
    return {
      x: originX + (screenX - originX) * factor,
      y: originY + (screenY - originY) * factor
    };
  }

  function clearPersistTimer() {
    if (persistTimerRef.current === null) return;
    window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = null;
  }

  async function persistPosition() {
    const body = bodyRef.current;
    const originX = metricsRef.current?.bounds.x ?? 0;
    const originY = metricsRef.current?.bounds.y ?? 0;
    const factor = worldScale || 1;
    // 世界坐标是物理像素，desktopPosition / placement 存的是逻辑单位（规格 §8）。
    const logicalX = (body.x - originX) / factor;
    const logicalY = (body.y - originY) / factor;
    try {
      await window.deskPet.applyPetPatch(petId, {
        desktopPosition: {
          x: Math.round(logicalX),
          y: Math.round(logicalY),
          direction: directionRef.current
        },
        // 规格 §8.3：layoutVersion 3 的 placement 才是权威位置。
        // 主进程是否落库由后端决定；未支持时该字段被忽略，不影响物理。
        layout: layout
          ? {
              ...layout,
              placement: {
                x: Math.round(logicalX + body.w / factor / 2),
                y: Math.round(logicalY + body.h / factor / 2),
                direction: directionRef.current
              }
            }
          : undefined
      });
    } catch {
      // 位置持久化失败不影响当前会话内的物理。
    }
  }

  function schedulePersist() {
    clearPersistTimer();
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      void persistPosition();
    }, 240);
  }

  function beginDrag(screenX: number, screenY: number, pointerId: number) {
    const world = screenToWorld(screenX, screenY);
    const body = bodyRef.current;
    const velocity = velocityRef.current;
    dragRef.current = {
      active: true,
      pointerId,
      offsetX: world.x - body.x,
      offsetY: world.y - body.y,
      lastX: world.x,
      lastY: world.y,
      lastAt: performance.now(),
      distance: 0
    };
    velocity.vx = 0;
    velocity.vy = 0;
    forceInteractiveRef.current = true;
    setVisual("drag");
  }

  function moveDrag(screenX: number, screenY: number) {
    const drag = dragRef.current;
    if (!drag.active) return;
    const world = screenToWorld(screenX, screenY);
    const now = performance.now();
    const dx = world.x - drag.lastX;
    const dy = world.y - drag.lastY;
    const elapsed = Math.max(8, now - drag.lastAt);
    drag.distance += Math.hypot(dx, dy);
    const body = bodyRef.current;
    const velocity = velocityRef.current;
    velocity.vx = (dx / elapsed) * 720;
    velocity.vy = (dy / elapsed) * 720;
    body.x = world.x - drag.offsetX;
    body.y = world.y - drag.offsetY;
    drag.lastX = world.x;
    drag.lastY = world.y;
    drag.lastAt = now;
    syncBodyToWindow();
  }

  function endDrag() {
    const drag = dragRef.current;
    if (!drag.active) return;
    drag.active = false;
    drag.pointerId = -1;
    forceInteractiveRef.current = menuOpenRef.current;
    const body = bodyRef.current;
    const velocity = velocityRef.current;
    if (drag.distance < DRAG_CLICK_DISTANCE_PX) {
      velocity.vx = 0;
      velocity.vy = 0;
      setVisual("idle");
      syncBodyToWindow();
      return;
    }
    applyDragInteraction();
    const speed = Math.hypot(velocity.vx, velocity.vy);
    const scale360 = speed > 1200 ? 1200 / speed : 1;
    velocity.vx = clamp(velocity.vx * scale360, -1200, 1200);
    velocity.vy = clamp(velocity.vy * scale360, -1000, 1400);
    body.grounded = false;
    body.supportY = null;
    body.supportLeft = null;
    body.supportRight = null;
    setEntityDirection(velocity.vx < 0 ? -1 : 1);
    setVisual("fall");
    syncBodyToWindow();
    schedulePersist();
  }

  function applyDragInteraction() {
    if (!state || !pet) return;
    const current = ensurePetVitals(pet, state.character);
    const next = recordPhysicalInteraction(current, Date.now());
    if (next === current) return;
    void window.deskPet.applyPetPatch(pet.id, { vitals: next }).catch(() => undefined);
  }

  // 拖动过程中监听全局鼠标移动 / 抬起；窗口跟随指针，因此屏幕坐标始终有效
  const dragHandlersRef = useRef({
    move: (_x: number, _y: number): void => undefined,
    end: (): void => undefined
  });
  dragHandlersRef.current = {
    move: moveDrag,
    end: endDrag
  };

  useEffect(() => {
    const handleMove = (event: MouseEvent | PointerEvent) => {
      const drag = dragRef.current;
      if (!drag.active) return;
      dragHandlersRef.current.move(event.screenX, event.screenY);
    };
    const handleUp = () => {
      dragHandlersRef.current.end();
    };
    window.addEventListener("mousemove", handleMove, true);
    window.addEventListener("pointermove", handleMove, true);
    window.addEventListener("mouseup", handleUp, true);
    window.addEventListener("pointerup", handleUp, true);
    window.addEventListener("pointercancel", handleUp, true);
    window.addEventListener("blur", handleUp, true);
    return () => {
      window.removeEventListener("mousemove", handleMove, true);
      window.removeEventListener("pointermove", handleMove, true);
      window.removeEventListener("mouseup", handleUp, true);
      window.removeEventListener("pointerup", handleUp, true);
      window.removeEventListener("pointercancel", handleUp, true);
      window.removeEventListener("blur", handleUp, true);
    };
  }, []);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    beginDrag(event.screenX, event.screenY, event.pointerId);
  }

  // ---- 自动文字：按契约发 pet-window:focus { take: true } ----
  const autoTextRef = useRef({ busy: false, requestId: 0, at: 0 });
  const autoTextDismissRef = useRef<number | null>(null);
  const canAutoTalk = Boolean(
    pet?.modulePlugins?.aiModuleId &&
      (pet.autoTextEnabled ?? pet.autoDialogueEnabled ?? true)
  );

  function takeFocus(take: boolean) {
    sendFocus(take);
  }

  function closeAutoText() {
    if (autoTextDismissRef.current !== null) {
      window.clearTimeout(autoTextDismissRef.current);
      autoTextDismissRef.current = null;
    }
    setAutoText("");
    takeFocus(false);
  }

  function showAutoText(text: string) {
    if (!isMeaningfulDialogueText(text)) return;
    setAutoText(text.trim());
    takeFocus(true);
    if (autoTextDismissRef.current !== null) {
      window.clearTimeout(autoTextDismissRef.current);
    }
    autoTextDismissRef.current = window.setTimeout(() => {
      autoTextDismissRef.current = null;
      setAutoText("");
      takeFocus(false);
    }, 14000);
  }

  async function triggerAutoText() {
    if (!pet || autoTextRef.current.busy || !canAutoTalk) return;
    if (menuOpenRef.current || dragRef.current.active) return;
    const requestId = autoTextRef.current.requestId + 1;
    autoTextRef.current.requestId = requestId;
    autoTextRef.current.busy = true;
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
      if (autoTextRef.current.requestId !== requestId) return;
      const text = String(result?.text || "").trim();
      if (!isMeaningfulDialogueText(text)) return;
      showAutoText(text);
      if (
        pet.modulePlugins?.voiceProfileId &&
        (pet.autoVoiceEnabled ?? pet.autoDialogueEnabled ?? true)
      ) {
        await window.deskPet.voiceAgent
          .speak(text, { voiceProfileId: pet.modulePlugins.voiceProfileId })
          .catch(() => undefined);
      }
    } catch {
      // 自动文字失败时静默等待下一轮。
    } finally {
      autoTextRef.current.busy = false;
      autoTextRef.current.at = Date.now();
    }
  }

  useEffect(() => {
    if (!canAutoTalk || !pet) return;
    const initiative = Number(pet.vitals?.initiative ?? 58);
    let nextAt = Date.now() + nextAutoTalkDelayMs(initiative);
    const timer = window.setInterval(() => {
      if (Date.now() < nextAt) return;
      nextAt = Date.now() + nextAutoTalkDelayMs(initiative);
      void triggerAutoText();
    }, 10000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAutoTalk, pet?.id, pet?.vitals?.initiative]);

  useEffect(
    () => () => {
      if (autoTextDismissRef.current !== null) {
        window.clearTimeout(autoTextDismissRef.current);
      }
      clearPersistTimer();
    },
    []
  );

  if (!petId) {
    return <div className="pet-window-root" />;
  }

  const geometry =
    geometryRef.current?.[direction] || geometryRef.current?.[1] || null;
  const visual = getVisualSize(pet?.desktopRenderConfig || pet?.renderConfig);
  const frameWidth = (geometry?.frame.width ?? 1) * cssScale;
  const frameHeight = (geometry?.frame.height ?? 1) * cssScale;
  const interaction = geometry?.interaction;
  const bubbleWidth = Math.max(180, Math.min(320, window.innerWidth - 16));

  /** 对话窗口锚点：显示框在世界坐标里的矩形（主进程会再做屏幕换算）。 */
  function displayFrameAnchor() {
    const current = geometryRef.current?.[directionRef.current];
    const body = bodyRef.current;
    if (!current) {
      return {
        petId,
        x: body.x,
        y: body.y,
        width: body.w,
        height: body.h,
        visible: true
      };
    }
    return {
      petId,
      x: body.x - current.collision.x + current.frame.x,
      y: body.y - current.collision.y + current.frame.y,
      width: current.frame.width,
      height: current.frame.height,
      visible: true
    };
  }

  return (
    <div
      ref={rootRef}
      className="pet-window-root"
      style={{ pointerEvents: "none" }}
    >
      {geometry && pet ? (
        <>
          <div
            className="pet-window-frame"
            style={{
              left: geometry.frame.x * cssScale,
              top: geometry.frame.y * cssScale,
              width: frameWidth,
              height: frameHeight
            }}
          >
            <div
              className={`pet-window-visual ${
                direction < 0 ? "pet-window-visual--left" : ""
              }`}
            >
              {pet.spine ? (
                <SpinePet
                  skelUrl={pet.spine.skelUrl}
                  state={visualState}
                  actionBindings={pet.actionBindings}
                  boneMap={pet.boneMap}
                  fitWidth={visual.visualWidth * scale}
                  fitHeight={visual.visualHeight * scale}
                  displayWidth={frameWidth}
                  displayHeight={frameHeight}
                  offsetX={(pet.desktopRenderConfig || pet.renderConfig)?.offsetX}
                  offsetY={(pet.desktopRenderConfig || pet.renderConfig)?.offsetY}
                  anchorBottom
                  normalizeBodySize
                  speedMultiplier={getAnimationSpeed()}
                  className="pet-window-spine"
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
          </div>
          <div
            ref={interactionRef}
            className="pet-window-interaction"
            data-pet-id={petId}
            style={{
              left: interaction ? interaction.x * cssScale : 0,
              top: interaction ? interaction.y * cssScale : 0,
              width: interaction ? interaction.width * cssScale : 1,
              height: interaction ? interaction.height * cssScale : 1,
              pointerEvents: "auto"
            }}
            onPointerDown={handlePointerDown}
            onDoubleClick={() => void window.deskPet.showControl()}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenuOpen(true);
            }}
          />
        </>
      ) : null}

      {menuOpen ? (
        <div
          ref={menuRef}
          className="overlay-menu pet-window-menu"
          style={{
            left: menuPosition.left,
            top: menuPosition.top,
            pointerEvents: "auto"
          }}
        >
          <button
            className="close-menu-button"
            type="button"
            onClick={() => setMenuOpen(false)}
          >
            <X size={16} />
            关闭
          </button>
          {pet?.modulePlugins?.aiModuleId ? (
            <button
              type="button"
              onClick={() => {
                closeAutoText();
                setMenuOpen(false);
                void window.deskPet.openChat(
                  "text",
                  undefined,
                  displayFrameAnchor()
                );
              }}
            >
              <MessageCircle size={16} />
              文字对话
            </button>
          ) : null}
          {pet?.modulePlugins?.voiceProfileId ? (
            <button
              type="button"
              onClick={() => {
                closeAutoText();
                setMenuOpen(false);
                void window.deskPet.openChat(
                  "voice",
                  undefined,
                  displayFrameAnchor()
                );
              }}
            >
              <Mic size={16} />
              语音对话
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              void window.deskPet.overlayCommand({ type: "rest", petId });
              setMenuOpen(false);
            }}
          >
            <Moon size={16} />
            桌面休眠
          </button>
          <button
            type="button"
            onClick={() => {
              void window.deskPet.overlayCommand({ type: "sleep", petId });
              setMenuOpen(false);
            }}
          >
            <Power size={16} />
            收回并休眠
          </button>
        </div>
      ) : null}

      {autoText && interaction ? (
        <div
          className="pet-window-bubble"
          style={{
            left: clamp(
              interaction.x * cssScale +
                (interaction.width * cssScale) / 2 -
                bubbleWidth / 2,
              4,
              Math.max(4, window.innerWidth - bubbleWidth - 4)
            ),
            top: clamp(
              interaction.y * cssScale - 34,
              4,
              Math.max(4, window.innerHeight - 34)
            ),
            width: bubbleWidth,
            background: dialogModule?.background || "#f7f5ef",
            borderColor: dialogModule?.borderColor || "#d9d7d0",
            color: dialogModule?.textColor || "#172033"
          }}
          onPointerDown={() => closeAutoText()}
        >
          {autoText}
        </div>
      ) : null}
    </div>
  );
}
