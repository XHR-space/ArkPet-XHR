import { clamp } from "./format";
import { makeId } from "./id";
import type { CharacterProfile, WellbeingState } from "../types";

export const RELATIONSHIP_MAX = 200;

// 精力越低，互动带来的好感收益越少；精力为 0 时完全不涨。
export function relationshipGainFactor(energy: number) {
  return clamp(Number(energy || 0) / 60, 0, 1);
}

// 好感越高，主动性越有底气，目标是角色基础主动性到更高的稳定值。
export function initiativeTargetForRelationship(
  character: CharacterProfile,
  relationship: number
) {
  const base = Number(character.initiative ?? 58);
  const affinity = clamp(Number(relationship || 0) / RELATIONSHIP_MAX, 0, 1);
  return clamp(base * 0.8 + affinity * 30, 20, 100);
}

export function ensureWellbeing(
  value: Partial<WellbeingState> | undefined,
  character: CharacterProfile
): WellbeingState {
  const now = new Date().toISOString();
  return {
    energy: Number(value?.energy ?? character.energy ?? 76),
    initiative: Number(value?.initiative ?? character.initiative ?? 58),
    relationship: clamp(
      Number(value?.relationship ?? character.relationship ?? 12),
      0,
      RELATIONSHIP_MAX
    ),
    zeroEnergySince: value?.zeroEnergySince,
    lastPhysicalInteractionAt: value?.lastPhysicalInteractionAt,
    mood: value?.mood || character.mood || "平静",
    moodScore: Number(value?.moodScore ?? 61),
    lastSimulatedAt: value?.lastSimulatedAt || now,
    lastInteractionAt: value?.lastInteractionAt || now,
    lastPetAt:
      value?.lastPetAt || new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    todayKey: value?.todayKey || now.slice(0, 10),
    today: {
      energyDelta: Number(value?.today?.energyDelta || 0),
      initiativeDelta: Number(value?.today?.initiativeDelta || 0),
      relationshipDelta: Number(value?.today?.relationshipDelta || 0),
      interactions: Number(value?.today?.interactions || 0),
      petCount: Number(value?.today?.petCount || 0)
    },
    recentEvents: Array.isArray(value?.recentEvents)
      ? value.recentEvents
      : []
  };
}

function dayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function moodLabel(score: number) {
  if (score < 24) return "疲惫";
  if (score < 43) return "低落";
  if (score < 66) return "平静";
  if (score < 84) return "开心";
  return "兴奋";
}

export function relationshipStage(value: number) {
  if (value < 20) return "陌生";
  if (value < 40) return "熟悉";
  if (value < 60) return "亲近";
  if (value < 80) return "信赖";
  return "默契";
}

export function calculateMoodScore(
  wellbeing: WellbeingState,
  now = Date.now()
) {
  const lastInteraction = new Date(wellbeing.lastInteractionAt).getTime();
  const minutesSinceInteraction = Number.isFinite(lastInteraction)
    ? Math.max(0, (now - lastInteraction) / 60000)
    : 999;
  const recentInteraction = Math.exp(-minutesSinceInteraction / 75) * 100;
  return clamp(
    wellbeing.energy * 0.45 +
      wellbeing.initiative * 0.2 +
      (clamp(wellbeing.relationship, 0, RELATIONSHIP_MAX) / 2) * 0.25 +
      recentInteraction * 0.1,
    0,
    100
  );
}

export function withUpdatedMood(
  wellbeing: WellbeingState,
  now = Date.now()
): WellbeingState {
  const moodScore = calculateMoodScore(wellbeing, now);
  return {
    ...wellbeing,
    moodScore,
    mood: moodLabel(moodScore)
  };
}

export function recordWellbeingInteraction(
  previous: WellbeingState,
  character: CharacterProfile,
  kind: "chat" | "pet",
  now = Date.now()
): WellbeingState {
  const gainFactor = relationshipGainFactor(previous.energy);
  const next = {
    ...previous,
    today: {
      ...previous.today,
      interactions:
        kind === "chat"
          ? previous.today.interactions + 1
          : previous.today.interactions,
      petCount:
        kind === "pet" ? previous.today.petCount + 1 : previous.today.petCount,
      relationshipDelta: previous.today.relationshipDelta,
      initiativeDelta: previous.today.initiativeDelta,
      energyDelta: previous.today.energyDelta
    }
  };

  if (kind === "chat") {
    const relationshipGain = 0.3 * gainFactor;
    next.relationship = clamp(
      previous.relationship + relationshipGain,
      0,
      RELATIONSHIP_MAX
    );
    next.initiative = clamp(
      previous.initiative + 2,
      0,
      100
    );
    next.today.relationshipDelta += relationshipGain;
    next.today.initiativeDelta += 2;
    next.lastInteractionAt = new Date(now).toISOString();
  } else {
    const lastPetAt = new Date(previous.lastPetAt).getTime();
    const canPet =
      !Number.isFinite(lastPetAt) || now - lastPetAt >= 30 * 60 * 1000;
    if (canPet) {
      const relationshipGain = 0.2 * gainFactor;
      next.relationship = clamp(
        previous.relationship + relationshipGain,
        0,
        RELATIONSHIP_MAX
      );
      next.initiative = clamp(previous.initiative + 1, 0, 100);
      next.today.relationshipDelta += relationshipGain;
      next.today.initiativeDelta += 1;
      next.lastPetAt = new Date(now).toISOString();
      next.lastInteractionAt = new Date(now).toISOString();
    }
  }

  return withUpdatedMood(next, now);
}

// 拖拽等身体互动：有精力时才涨好感，且每分钟最多结算一次。
export function recordPhysicalInteraction(
  previous: WellbeingState,
  now = Date.now()
) {
  const gainFactor = relationshipGainFactor(previous.energy);
  if (gainFactor <= 0) return previous;
  const lastAt = new Date(previous.lastPhysicalInteractionAt || 0).getTime();
  if (Number.isFinite(lastAt) && now - lastAt < 60 * 1000) return previous;
  const relationshipGain = 0.08 * gainFactor;
  const initiativeGain = 0.4 * gainFactor;
  const next: WellbeingState = {
    ...previous,
    relationship: clamp(
      previous.relationship + relationshipGain,
      0,
      RELATIONSHIP_MAX
    ),
    initiative: clamp(previous.initiative + initiativeGain, 0, 100),
    lastPhysicalInteractionAt: new Date(now).toISOString(),
    lastInteractionAt: new Date(now).toISOString(),
    today: {
      ...previous.today,
      relationshipDelta:
        previous.today.relationshipDelta + relationshipGain,
      initiativeDelta: previous.today.initiativeDelta + initiativeGain
    }
  };
  return withUpdatedMood(next, now);
}

export function appendWellbeingEvent(
  wellbeing: WellbeingState,
  type: string,
  text: string,
  now = Date.now()
): WellbeingState {
  return {
    ...wellbeing,
    recentEvents: [
      {
        id: makeId("wellbeing"),
        type,
        text,
        createdAt: new Date(now).toISOString()
      },
      ...wellbeing.recentEvents
    ].slice(0, 40)
  };
}
