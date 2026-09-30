import { Moon, Power, X } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent
} from "react";
import { clamp } from "../lib/format";
import { getVisualSize } from "../lib/renderConfig";
import type {
  AppSettings,
  AppState,
  DisplayMetrics,
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
  dragOffsetX: number;
  dragOffsetY: number;
  lastPointerX: number;
  lastPointerY: number;
  lastPointerAt: number;
  nextIdleAt: number;
  idleUntil: number;
  thrown: boolean;
};

type EntityProps = {
  pet: PetProfile;
  overlaySettings: AppSettings["overlay"];
  metrics: DisplayMetrics;
  registry: MutableRefObject<Map<string, EntitySnapshot>>;
  canInteract: boolean;
};

const BASE_WIDTH = 104;
const BASE_HEIGHT = 134;

export function MultiPetOverlay() {
  const [appState, setAppState] = useState<AppState | null>(null);
  const [overlaySettings, setOverlaySettings] =
    useState<AppSettings["overlay"] | null>(null);
  const [metrics, setMetrics] = useState<DisplayMetrics | null>(null);
  const registry = useRef(new Map<string, EntitySnapshot>());

  useEffect(() => {
    function handleMouseMove(event: MouseEvent) {
      const hit = Array.from(registry.current.values()).some((entity) => {
        const inHitbox =
          event.clientX >= entity.x + entity.hitboxOffsetX &&
          event.clientX <=
            entity.x + entity.hitboxOffsetX + entity.width &&
          event.clientY >= entity.y + entity.hitboxOffsetY &&
          event.clientY <=
            entity.y + entity.hitboxOffsetY + entity.height;
        const inMenu =
          entity.menu &&
          event.clientX >= entity.menu.x &&
          event.clientX <= entity.menu.x + entity.menu.width &&
          event.clientY >= entity.menu.y &&
          event.clientY <= entity.menu.y + entity.menu.height;
        return inHitbox || inMenu;
      });
      const anyMenuOpen = Array.from(registry.current.values()).some(
        (entity) => Boolean(entity.menu)
      );
      window.deskPet.setOverlayMouseIgnore(!(hit || anyMenuOpen));
    }
    function handleMouseLeave() {
      window.deskPet.setOverlayMouseIgnore(true);
    }
    window.addEventListener("mousemove", handleMouseMove, { passive: true });
    window.addEventListener("mouseleave", handleMouseLeave);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseleave", handleMouseLeave);
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    window.deskPet.getState().then((state) => {
      if (!mounted) return;
      setAppState(state);
      setOverlaySettings(state.settings.overlay);
    });
    window.deskPet.getDisplayMetrics().then((nextMetrics) => {
      if (mounted) setMetrics(nextMetrics);
    });
    const stateSubscription = window.deskPet.onStateChanged(setAppState);
    const settingsSubscription =
      window.deskPet.onOverlaySettings(setOverlaySettings);
    const displaySubscription = window.deskPet.onDisplayChanged(setMetrics);
    return () => {
      mounted = false;
      stateSubscription();
      settingsSubscription();
      displaySubscription();
    };
  }, []);

  if (!appState || !overlaySettings || !metrics) return null;
  const summonedPets = appState.summonedPetIds
    .map((petId) => appState.pets.find((pet) => pet.id === petId))
    .filter(Boolean) as PetProfile[];

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
  canInteract
}: EntityProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const visualRef = useRef<HTMLDivElement | null>(null);
  const hitboxRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuCloseTimer = useRef<number | null>(null);
  const [visualState, setVisualState] = useState<
    "idle" | "walk" | "fall" | "land" | "drag" | "sleep"
  >("idle");
  const [direction, setDirection] = useState<1 | -1>(1);
  const [menuOpen, setMenuOpen] = useState(false);
  const [zIndex, setZIndex] = useState(10);
  const scale = (overlaySettings.scale || 1) * (pet.scale || 1);
  const width = (pet.renderConfig?.hitboxWidth || BASE_WIDTH) * scale;
  const height = (pet.renderConfig?.hitboxHeight || BASE_HEIGHT) * scale;
  const visual = getVisualSize(pet.renderConfig);
  const visualWidth = visual.visualWidth * scale;
  const visualHeight = visual.visualHeight * scale;
  const canvasWidth =
    Math.max(pet.renderConfig?.displayWidth || 260, visual.visualWidth) * scale;
  const canvasHeight =
    Math.max(pet.renderConfig?.displayHeight || 320, visual.visualHeight) * scale;
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
    hitboxOffsetX: (pet.renderConfig?.hitboxOffsetX || 0) * scale,
    hitboxOffsetY: (pet.renderConfig?.hitboxOffsetY || 0) * scale,
    vx: 0,
    vy: 0,
    direction: 1,
    directionY: -1,
    passUntil: 0,
    zIndex: 10,
    dragging: false,
    grounded: true,
    dragOffsetX: 0,
    dragOffsetY: 0,
    lastPointerX: 0,
    lastPointerY: 0,
    lastPointerAt: 0,
    nextIdleAt: performance.now() + 3000,
    idleUntil: 0
    ,
    thrown: false
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

  function sync() {
    const entity = physics.current;
    entity.width = width;
    entity.height = height;
    if (hostRef.current) {
      hostRef.current.style.left = `${entity.x}px`;
      hostRef.current.style.top = `${entity.y}px`;
      hostRef.current.style.width = `${width}px`;
      hostRef.current.style.height = `${height}px`;
      hostRef.current.style.zIndex = String(zIndex);
    }
    if (hitboxRef.current) {
      entity.hitboxOffsetX = (pet.renderConfig?.hitboxOffsetX || 0) * scale;
      entity.hitboxOffsetY = (pet.renderConfig?.hitboxOffsetY || 0) * scale;
      hitboxRef.current.style.left = `${entity.hitboxOffsetX}px`;
      hitboxRef.current.style.top = `${entity.hitboxOffsetY}px`;
    }
    if (menuRef.current && menuOpen) {
      const menuWidth = menuRef.current.offsetWidth || 150;
      const menuHeight = menuRef.current.offsetHeight || 90;
      const rightX = entity.x + width + 10;
      const leftX = entity.x - menuWidth - 10;
      const x =
        rightX + menuWidth < window.innerWidth - 8
          ? rightX
          : clamp(leftX, 8, window.innerWidth - menuWidth - 8);
      const y = clamp(
        entity.y + height / 2 - menuHeight / 2,
        8,
        window.innerHeight - menuHeight - 8
      );
      menuRef.current.style.left = `${x}px`;
      menuRef.current.style.top = `${y}px`;
      entity.menu = {
        x,
        y,
        width: menuWidth,
        height: menuHeight
      };
    } else {
      entity.menu = undefined;
    }
    registry.current.set(pet.id, { ...entity });
  }

  function scheduleMenuClose() {
    if (menuCloseTimer.current !== null) {
      window.clearTimeout(menuCloseTimer.current);
    }
    menuCloseTimer.current = window.setTimeout(() => {
      setMenuOpen(false);
      menuCloseTimer.current = null;
    }, 260);
  }

  useEffect(() => {
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const delta = Math.min(0.04, (now - previous) / 1000);
      previous = now;
      const entity = physics.current;

      if (entity.dragging) {
        setVisualState("drag");
      } else if (!overlaySettings.gravityLocked) {
        if (entity.idleUntil > now) {
          entity.vx = 0;
          entity.vy = 0;
          setVisualState("idle");
        } else {
          if (Math.abs(entity.vx) < 4 || Math.abs(entity.vy) < 4) {
            entity.vx = effectiveWalkSpeed * entity.direction;
            entity.vy = effectiveWalkSpeed * entity.directionY;
            entity.thrown = false;
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
              entity.idleUntil = now + 3200;
            }
          }
          setDirection(entity.direction);
          setVisualState("walk");
        }
      } else {
        if (entity.thrown && friction > 0) {
          const amount = Math.pow(friction, 1.45) * 520 * delta;
          if (Math.abs(entity.vx) <= amount) entity.vx = 0;
          else entity.vx -= Math.sign(entity.vx) * amount;
        }
        entity.vy += Number(overlaySettings.gravity || 1800) * delta;
        entity.x += entity.vx * delta;
        entity.y += entity.vy * delta;

        if (entity.x < bounds.left) {
          entity.x = bounds.left;
          entity.vx =
            Math.abs(entity.vx) * (entity.thrown ? wallBounce : 1);
          entity.direction = 1;
          setDirection(1);
        }
        const rightLimit = Math.max(bounds.left, bounds.right - width);
        if (entity.x > rightLimit) {
          entity.x = rightLimit;
          entity.vx =
            -Math.abs(entity.vx) * (entity.thrown ? wallBounce : 1);
          entity.direction = -1;
          setDirection(-1);
        }

        const floorY = bounds.floor - height;
        if (entity.y >= floorY) {
          const impactSpeed = Math.abs(entity.vy);
          const wasFalling = entity.vy > 100;
          entity.y = floorY;
          if (entity.thrown && groundBounce > 0 && impactSpeed > 120) {
            entity.vy = -impactSpeed * groundBounce * 0.55;
            entity.grounded = false;
            setVisualState("fall");
          } else {
            entity.vy = 0;
            entity.grounded = true;

            if (entity.thrown) {
              if (friction >= 0.99) {
                entity.vx = 0;
                entity.thrown = false;
              }
            }

            if (entity.idleUntil > now) {
              entity.vx = 0;
              setVisualState("idle");
            } else if (now >= entity.nextIdleAt) {
              const seconds = Math.max(
                5,
                Number(overlaySettings.idleActionIntervalSeconds || 20)
              );
              entity.nextIdleAt = now + seconds * 1000;
              if (
                overlaySettings.idleActionEnabled &&
                Math.random() * 100 < overlaySettings.idleActionChance
              ) {
                entity.vx = 0;
                entity.idleUntil = now + 3200;
                setVisualState("idle");
              } else {
                entity.direction = Math.random() > 0.5 ? 1 : -1;
                entity.vx = effectiveWalkSpeed * entity.direction;
                setDirection(entity.direction);
                setVisualState("walk");
              }
            } else if (Math.abs(entity.vx) > 4) {
              setVisualState("walk");
            } else {
              setVisualState("idle");
            }

            if (wasFalling) setVisualState("land");
          }
        } else {
          entity.grounded = false;
          if (entity.vy > 80) setVisualState("fall");
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
              setDirection(entity.direction);
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
    overlaySettings,
    canInteract,
    zIndex
  ]);

  useEffect(
    () => () => {
      registry.current.delete(pet.id);
    },
    [pet.id]
  );

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

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const entity = physics.current;
    entity.dragging = true;
    entity.dragOffsetX = event.clientX - entity.x;
    entity.dragOffsetY = event.clientY - entity.y;
    entity.lastPointerX = event.clientX;
    entity.lastPointerY = event.clientY;
    entity.lastPointerAt = performance.now();
    entity.vx = 0;
    entity.vy = 0;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const entity = physics.current;
    if (!entity.dragging) return;
    const now = performance.now();
    const delta = Math.max(8, now - entity.lastPointerAt);
    entity.vx = ((event.clientX - entity.lastPointerX) / delta) * 720;
    entity.vy = ((event.clientY - entity.lastPointerY) / delta) * 720;
    entity.x = event.clientX - entity.dragOffsetX;
    entity.y = event.clientY - entity.dragOffsetY;
    entity.lastPointerX = event.clientX;
    entity.lastPointerY = event.clientY;
    entity.lastPointerAt = now;
    sync();
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const entity = physics.current;
    if (!entity.dragging) return;
    entity.dragging = false;
    entity.vx = clamp(entity.vx, -1200, 1200);
    entity.vy = clamp(entity.vy, -1000, 1400);
    entity.grounded = false;
    entity.direction = entity.vx < 0 ? -1 : 1;
    entity.directionY = entity.vy < 0 ? -1 : 1;
    entity.thrown = true;
    setDirection(entity.direction);
    setVisualState("fall");
    event.currentTarget.releasePointerCapture(event.pointerId);
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
            displayWidth={canvasWidth}
            displayHeight={canvasHeight}
            offsetX={pet.renderConfig?.offsetX}
            offsetY={pet.renderConfig?.offsetY}
            anchorBottom
            normalizeBodySize
            speedMultiplier={animationSpeed}
            className="multi-pet-spine"
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
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => window.deskPet.showControl()}
        onContextMenu={(event) => {
          event.preventDefault();
          window.deskPet.setOverlayMouseIgnore(false);
          setMenuOpen(true);
        }}
      />
      {menuOpen && (
        <div
          ref={menuRef}
          className="overlay-menu multi-pet-menu"
          onMouseEnter={() => {
            if (menuCloseTimer.current !== null) {
              window.clearTimeout(menuCloseTimer.current);
            }
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
        </div>
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
