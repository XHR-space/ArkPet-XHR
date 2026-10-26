import { Spine } from "@pixi-spine/all-3.8";
import "@pixi/unsafe-eval";
import { Application, Assets } from "pixi.js";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import {
  analyzeBoneMap,
  chooseBoundAnimation
} from "../lib/spineActions";
import {
  applyFirstPetLegWalk,
  FIRST_PET_LEG_WALK
} from "../lib/firstPetLegWalk";
import type { ActionBindings, BoneRoleMap } from "../types";

type SpineVisualState =
  | "idle"
  | "walk"
  | "fall"
  | "land"
  | "drag"
  | "windDown"
  | "sleep"
  | "excited";

type SpinePetProps = {
  skelUrl: string;
  state: SpineVisualState;
  className?: string;
  fallback?: ReactNode;
  fitWidth?: number;
  fitHeight?: number;
  fitRatio?: number;
  offsetX?: number;
  offsetY?: number;
  displayWidth?: number;
  displayHeight?: number;
  anchorBottom?: boolean;
  normalizeBodySize?: boolean;
  speedMultiplier?: number;
  maxFPS?: number;
  deferMountMs?: number;
  actionBindings?: ActionBindings;
  actionOverride?: string;
  boneMap?: BoneRoleMap;
  onAnimations?: (animations: string[]) => void;
  onAnimationData?: (items: Array<{ name: string; duration: number }>) => void;
  onSkeletonInfo?: (info: {
    animations: string[];
    durations: Record<string, number>;
    boneMap: BoneRoleMap;
  }) => void;
};

const stateActionIds: Record<SpineVisualState, string> = {
  idle: "idle",
  walk: "walk",
  fall: "fall",
  land: "land",
  drag: "drag",
  windDown: "sleep",
  sleep: "sleep",
  excited: "idle"
};

function pickAnimation(
  available: string[],
  state: SpineVisualState,
  actionBindings?: ActionBindings,
  actionOverride?: string,
  durations?: Record<string, number>
): string | undefined {
  const isPlayable = (name: string) =>
    !durations || Number(durations[name] || 0) > 0;
  if (actionOverride) {
    const overrideMatch = available.find(
      (name) => name.toLowerCase() === actionOverride.toLowerCase()
    );
    if (overrideMatch) return overrideMatch;
  }
  const bound = chooseBoundAnimation(
    stateActionIds[state],
    actionBindings,
    available,
    durations
  );
  if (
    state === "walk" &&
    actionBindings?.walk === FIRST_PET_LEG_WALK
  ) {
    const baseCandidates = ["Idle", "Relax", "Special", "Default"];
    for (const candidate of baseCandidates) {
      const match = available.find(
        (name) => name.toLowerCase() === candidate.toLowerCase()
      );
      if (match && isPlayable(match)) return match;
    }
  }
  if (bound) return bound;
  const byState: Record<SpineVisualState, string[]> = {
    idle: ["Special", "Relax", "Sit", "Idle"],
    walk: ["Move", "Walk", "Idle", "Relax", "Default"],
    fall: ["Special", "Relax"],
    land: ["Special", "Relax"],
    drag: ["Interact", "Relax", "Special"],
    windDown: ["Relax", "Sit", "Sleep"],
    sleep: ["Sleep", "Relax", "Default"],
    excited: ["Interact", "Special", "Default"]
  };

  const lowerCaseNames = new Map(
    available.map((name) => [name.toLowerCase(), name])
  );
  for (const candidate of byState[state]) {
    const match = lowerCaseNames.get(candidate.toLowerCase());
    if (match && isPlayable(match)) return match;
  }
  return available[0];
}

export function SpinePet({
  skelUrl,
  state,
  className = "",
  fallback = null,
  fitWidth,
  fitHeight,
  fitRatio = 0.78,
  offsetX = 0,
  offsetY = 0,
  displayWidth,
  displayHeight,
  anchorBottom = false,
  normalizeBodySize = false,
  speedMultiplier = 0.82,
  maxFPS,
  deferMountMs = 0,
  actionBindings,
  actionOverride,
  boneMap,
  onAnimations,
  onAnimationData,
  onSkeletonInfo
}: SpinePetProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const applicationRef = useRef<Application | null>(null);
  const spineRef = useRef<Spine | null>(null);
  const fitToHostRef = useRef<() => void>(() => undefined);
  const fitCacheRef = useRef<{
    hostWidth: number;
    hostHeight: number;
    fitWidth: number | null;
    fitHeight: number | null;
    fitRatio: number;
    normalizeBodySize: boolean;
    bounds: { x: number; y: number; width: number; height: number };
    scale: number;
  } | null>(null);
  const layoutRef = useRef({
    fitWidth,
    fitHeight,
    fitRatio,
    offsetX,
    offsetY,
    anchorBottom,
    normalizeBodySize
  });
  const maxFPSRef = useRef(maxFPS);
  const availableAnimationsRef = useRef<string[]>([]);
  const animationDurationsRef = useRef<Record<string, number>>({});
  const onAnimationsRef = useRef(onAnimations);
  const onAnimationDataRef = useRef(onAnimationData);
  const onSkeletonInfoRef = useRef(onSkeletonInfo);
  const boneMapRef = useRef(boneMap);
  const presetWalkRef = useRef(false);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  layoutRef.current = {
    fitWidth,
    fitHeight,
    fitRatio,
    offsetX,
    offsetY,
    anchorBottom,
    normalizeBodySize
  };
  maxFPSRef.current = maxFPS;

  useEffect(() => {
    onAnimationsRef.current = onAnimations;
    onAnimationDataRef.current = onAnimationData;
    onSkeletonInfoRef.current = onSkeletonInfo;
    boneMapRef.current = boneMap;
    presetWalkRef.current =
      state === "walk" && actionBindings?.walk === FIRST_PET_LEG_WALK;
  }, [
    onAnimations,
    onAnimationData,
    onSkeletonInfo,
    boneMap,
    state,
    actionBindings
  ]);

  useEffect(() => {
    let disposed = false;
    let application: Application | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let fitFrame: number | null = null;
    let mountTimer: number | null = null;
    let visibilityHandler: (() => void) | null = null;
    setFailed(false);
    setReady(false);
    fitCacheRef.current = null;

    async function mount() {
      const host = hostRef.current;
      if (!host) return;
      fitCacheRef.current = null;

      try {
        application = new Application({
          resizeTo: host,
          backgroundAlpha: 0,
          antialias: true,
          autoDensity: true,
          resolution: Math.min(2, window.devicePixelRatio || 1)
        });
        applicationRef.current = application;
        if (maxFPSRef.current !== undefined) {
          application.ticker.maxFPS = maxFPSRef.current;
        }
        visibilityHandler = () => {
          if (!application) return;
          if (document.visibilityState === "hidden") {
            application.ticker.stop();
          } else if (!application.ticker.started) {
            application.ticker.start();
          }
        };
        document.addEventListener("visibilitychange", visibilityHandler);
        visibilityHandler();
        const canvas = application.view as unknown as HTMLCanvasElement;
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.display = "block";
        host.appendChild(canvas);

        const resource = (await Assets.load(skelUrl)) as {
          spineData: ConstructorParameters<typeof Spine>[0];
        };
        if (disposed) return;

        const spine = new Spine(resource.spineData);
        spineRef.current = spine;
        const originalUpdateWorldTransform =
          spine.skeleton.updateWorldTransform.bind(spine.skeleton);
        spine.skeleton.updateWorldTransform = function () {
          if (presetWalkRef.current) {
            applyFirstPetLegWalk(
              spine.skeleton,
              boneMapRef.current,
              performance.now()
            );
          }
          return originalUpdateWorldTransform();
        } as typeof spine.skeleton.updateWorldTransform;
        application.stage.addChild(spine);

        const animationNames = resource.spineData.animations.map(
          (animation) => animation.name
        );
        const animationDurations = Object.fromEntries(
          resource.spineData.animations.map((animation) => [
            animation.name,
            animation.duration
          ])
        );
        const boneNames = resource.spineData.bones.map((bone) => bone.name);
        animationDurationsRef.current = animationDurations;
        spine.state.data.defaultMix = 0.32;
        try {
          spine.state.data.setMix("Move", "Relax", 0.38);
          spine.state.data.setMix("Relax", "Sleep", 0.55);
          spine.state.data.setMix("Sit", "Sleep", 0.55);
        } catch {
          // Some exported skeletons omit one of the transition clips.
        }
        availableAnimationsRef.current = animationNames;
        onAnimationsRef.current?.(animationNames);
        onAnimationDataRef.current?.(
          resource.spineData.animations.map((animation) => ({
            name: animation.name,
            duration: animation.duration
          }))
        );
        onSkeletonInfoRef.current?.({
          animations: animationNames,
          durations: animationDurations,
          boneMap: analyzeBoneMap(boneNames)
        });

        const positionSpineToHost = (
          bounds: { x: number; y: number; width: number; height: number },
          scale: number,
          width: number,
          height: number
        ) => {
          const activeApplication = application;
          if (!activeApplication) return;
          if (
            activeApplication.renderer.screen.width !== width ||
            activeApplication.renderer.screen.height !== height
          ) {
            activeApplication.resize();
          }
          const {
            offsetX: currentOffsetX,
            offsetY: currentOffsetY,
            anchorBottom: currentAnchorBottom
          } = layoutRef.current;
          spine.scale.set(scale);
          host.dataset.spineScale = scale.toFixed(4);
          const x =
            (width - bounds.width * scale) / 2 -
            bounds.x * scale +
            currentOffsetX;
          const y = currentAnchorBottom
            ? height -
              2 -
              (bounds.y + bounds.height) * scale +
              currentOffsetY
            : (height - bounds.height * scale) / 2 -
              bounds.y * scale +
              currentOffsetY;
          spine.position.set(x, y);
        };

        const fitToHost = () => {
          if (!application) return;
          const {
            fitWidth: nextFitWidth,
            fitHeight: nextFitHeight,
            fitRatio: nextFitRatio,
            normalizeBodySize: nextNormalizeBodySize
          } = layoutRef.current;
          const width = Math.max(1, host.clientWidth);
          const height = Math.max(1, host.clientHeight);
          const desiredWidth = nextFitWidth || width;
          const desiredHeight = nextFitHeight || height;
          const fitWidthKey = nextFitWidth ?? null;
          const fitHeightKey = nextFitHeight ?? null;
          const cached = fitCacheRef.current;
          const cacheMatches =
            cached !== null &&
            cached.hostWidth === width &&
            cached.hostHeight === height &&
            cached.fitWidth === fitWidthKey &&
            cached.fitHeight === fitHeightKey &&
            cached.fitRatio === nextFitRatio &&
            cached.normalizeBodySize === nextNormalizeBodySize;

          if (!cacheMatches || !cached) {
            spine.skeleton.updateWorldTransform();
            const bounds = spine.getLocalBounds();
            if (!bounds.width || !bounds.height) return;
            const bones = spine.skeleton.bones;
            const headBone = bones.find((bone) =>
              /f_head(_[^ ]+)?$|^head$/i.test(bone.data.name)
            );
            const hipBone = bones.find((bone) =>
              /f_hip(_[^ ]+)?$|^hip$/i.test(bone.data.name)
            );
            const waistBone = bones.find((bone) =>
              /f_waist(_[^ ]+)?$|^waist$/i.test(bone.data.name)
            );
            const bodyHeight =
              headBone && hipBone
                ? Math.abs(headBone.worldY - hipBone.worldY)
                : headBone && waistBone
                  ? Math.abs(headBone.worldY - waistBone.worldY)
                  : 0;
            const boundsScale =
              Math.min(
                desiredWidth / bounds.width,
                desiredHeight / bounds.height
              ) * nextFitRatio;
            const bodyScale =
              bodyHeight > 1
                ? (desiredHeight * 0.104) / bodyHeight
                : boundsScale;
            fitCacheRef.current = {
              hostWidth: width,
              hostHeight: height,
              fitWidth: fitWidthKey,
              fitHeight: fitHeightKey,
              fitRatio: nextFitRatio,
              normalizeBodySize: nextNormalizeBodySize,
              bounds: {
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height
              },
              scale:
                nextNormalizeBodySize && bodyHeight > 1
                  ? bodyScale
                  : boundsScale
            };
          }

          const fitCache = fitCacheRef.current;
          if (!fitCache) return;
          const { bounds, scale } = fitCache;
          positionSpineToHost(bounds, scale, width, height);
        };
        fitToHostRef.current = fitToHost;

        const initialName = pickAnimation(
          animationNames,
          state,
          actionBindings,
          actionOverride,
          animationDurations
        );
        if (initialName) spine.state.setAnimation(0, initialName, true);
        spine.update(0);

        fitToHost();
        fitFrame = requestAnimationFrame(fitToHost);
        resizeObserver = new ResizeObserver(fitToHost);
        resizeObserver.observe(host);
        setReady(true);
      } catch (error) {
        const details =
          error instanceof Error ? error.stack || error.message : String(error);
        console.error("Spine load failed", details);
        if (!disposed) setFailed(true);
      }
    }

    if (deferMountMs > 0) {
      mountTimer = window.setTimeout(() => {
        mountTimer = null;
        void mount();
      }, deferMountMs);
    } else {
      void mount();
    }
    return () => {
      disposed = true;
      if (mountTimer !== null) {
        window.clearTimeout(mountTimer);
        mountTimer = null;
      }
      if (visibilityHandler) {
        document.removeEventListener("visibilitychange", visibilityHandler);
        visibilityHandler = null;
      }
      if (fitFrame !== null) cancelAnimationFrame(fitFrame);
      resizeObserver?.disconnect();
      fitToHostRef.current = () => undefined;
      fitCacheRef.current = null;
      applicationRef.current = null;
      spineRef.current = null;
      availableAnimationsRef.current = [];
      application?.destroy(true, {
        children: true,
        texture: false,
        baseTexture: false
      });
    };
  }, [skelUrl, deferMountMs]);

  useEffect(() => {
    const application = applicationRef.current;
    if (!application || maxFPS === undefined) return;
    application.ticker.maxFPS = maxFPS;
  }, [maxFPS]);


  useLayoutEffect(() => {
    fitToHostRef.current();
  }, [
    fitWidth,
    fitHeight,
    fitRatio,
    offsetX,
    offsetY,
    displayWidth,
    displayHeight,
    anchorBottom,
    normalizeBodySize
  ]);

  useEffect(() => {
    if (!ready || !spineRef.current) return;
    const name = pickAnimation(
      availableAnimationsRef.current,
      state,
      actionBindings,
      actionOverride,
      animationDurationsRef.current
    );
    if (!name) return;
    const spine = spineRef.current;
    spine.state.setAnimation(0, name, true);
    spine.update(0);
    // Animation changes update playback only; layout is handled by the layout effect above.
  }, [ready, state, actionBindings, actionOverride]);

  useEffect(() => {
    if (!ready || !spineRef.current) return;
    const spine = spineRef.current;
    spine.state.timeScale =
      state === "walk"
        ? Math.min(4.5, Math.max(0.3, speedMultiplier))
        : state === "drag"
          ? 1.35
          : state === "windDown"
            ? 0.86
          : 1;
  }, [ready, state, speedMultiplier]);

  if (failed) return <>{fallback}</>;

  return (
    <div
      ref={hostRef}
      className={`spine-pet ${className}`}
      style={{
        opacity: ready ? 1 : 0,
        ...(displayWidth ? { width: displayWidth } : {}),
        ...(displayHeight ? { height: displayHeight } : {})
      }}
      aria-label="Spine 桌宠动画"
    />
  );
}
