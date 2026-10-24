import { clamp } from "./format";
import {
  calculateMoodScore,
  ensureWellbeing,
  initiativeTargetForRelationship,
  relationshipGainFactor,
  RELATIONSHIP_MAX,
  moodLabel
} from "./wellbeing";
import type { CharacterProfile, PetProfile, PetVitals } from "../types";

const RELATIONSHIP_PER_ENERGY = 0.18;
const ZERO_ENERGY_GRACE_MINUTES = 5;
const ZERO_ENERGY_RELATIONSHIP_PENALTY_PER_MINUTE = 0.4;
export const AUTO_RECALL_ZERO_ENERGY_MS = 20 * 60 * 1000;
const MAX_CATCH_UP_MS = 2 * 60 * 1000;

function dayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

export function ensurePetVitals(
  pet: PetProfile,
  character: CharacterProfile
): PetVitals {
  if (pet.vitals) {
    const relationship = clamp(
      Number(pet.vitals.relationship ?? 12),
      0,
      RELATIONSHIP_MAX
    );
    return relationship === pet.vitals.relationship
      ? pet.vitals
      : { ...pet.vitals, relationship };
  }
  const base = ensureWellbeing(undefined, character);
  const legacyRelationship = Number(pet.desktopRelationship);
  return {
    ...base,
    relationship: Number.isFinite(legacyRelationship)
      ? legacyRelationship
      : base.relationship,
    secondsToday: Math.max(0, Number(pet.desktopSecondsToday || 0)),
    secondsTotal: Math.max(0, Number(pet.desktopSecondsTotal || 0))
  };
}

export function advancePetVitals(
  vitals: PetVitals,
  character: CharacterProfile,
  active: boolean,
  now = Date.now()
): PetVitals {
  const sampleAt = new Date(vitals.lastSimulatedAt || now).getTime();
  const rawElapsedMs = Number.isFinite(sampleAt)
    ? Math.max(0, now - sampleAt)
    : 0;
  const elapsedMinutes = clamp(rawElapsedMs, 0, MAX_CATCH_UP_MS) / 60000;
  const currentDay = dayKey(now);
  const rollover = vitals.todayKey !== currentDay;

  const previousEnergy = clamp(Number(vitals.energy ?? 76), 0, 100);
  let energy = previousEnergy;
  let initiative = Number(vitals.initiative ?? 58);
  let relationship = clamp(
    Number(vitals.relationship ?? 12),
    0,
    RELATIONSHIP_MAX
  );
  let zeroEnergySince = vitals.zeroEnergySince;
  let energyDelta = rollover ? 0 : Number(vitals.today?.energyDelta || 0);
  let initiativeDelta = rollover
    ? 0
    : Number(vitals.today?.initiativeDelta || 0);
  let relationshipDelta = rollover
    ? 0
    : Number(vitals.today?.relationshipDelta || 0);

  const energyChange = active ? -0.2 * elapsedMinutes : 0.67 * elapsedMinutes;
  energy = clamp(energy + energyChange, 0, 100);
  energyDelta += energy - previousEnergy;

  // 精力被消耗多少，就按比例换多少好感；精力低时收益会明显放缓。
  if (active) {
    const drainedEnergy = Math.max(0, previousEnergy - energy);
    const relationshipChange =
      drainedEnergy *
      RELATIONSHIP_PER_ENERGY *
      relationshipGainFactor(previousEnergy);
    relationship = clamp(
      relationship + relationshipChange,
      0,
      RELATIONSHIP_MAX
    );
    relationshipDelta += relationshipChange;
  }

  if (active && energy <= 0.01) {
    if (!zeroEnergySince) zeroEnergySince = new Date(now).toISOString();
    const zeroSince = new Date(zeroEnergySince).getTime();
    const zeroMinutes = Number.isFinite(zeroSince)
      ? Math.max(0, (now - zeroSince) / 60000)
      : 0;
    if (zeroMinutes > ZERO_ENERGY_GRACE_MINUTES) {
      const penaltyMinutes = Math.min(
        elapsedMinutes,
        zeroMinutes - ZERO_ENERGY_GRACE_MINUTES
      );
      const penalty =
        penaltyMinutes * ZERO_ENERGY_RELATIONSHIP_PENALTY_PER_MINUTE;
      relationship = clamp(relationship - penalty, 0, RELATIONSHIP_MAX);
      relationshipDelta -= penalty;
    }
  } else if (!active || energy > 1) {
    zeroEnergySince = undefined;
  }

  const lastInteractionAt = new Date(vitals.lastInteractionAt || now).getTime();
  const minutesSinceInteraction = Number.isFinite(lastInteractionAt)
    ? Math.max(0, (now - lastInteractionAt) / 60000)
    : 0;
  // 好感越高，主动性目标值越高；长时间不互动只会回落到与好感相符的下限。
  const initiativeTarget = initiativeTargetForRelationship(
    character,
    relationship
  );
  const initiativeFloor = clamp(
    Number(character.initiative ?? 58) * 0.35 +
      (relationship / RELATIONSHIP_MAX) * 50,
    15,
    80
  );
  const initiativeGoal =
    active && minutesSinceInteraction > 15 ? initiativeFloor : initiativeTarget;
  const initiativeRate = active && minutesSinceInteraction > 15 ? 0.2 : 0.25;
  const before = initiative;
  initiative +=
    clamp(initiativeGoal - initiative, -initiativeRate, initiativeRate) *
    elapsedMinutes;
  initiativeDelta += initiative - before;

  const elapsedSeconds = active ? elapsedMinutes * 60 : 0;
  const advanced: PetVitals = {
    ...vitals,
    energy,
    initiative,
    relationship,
    zeroEnergySince,
    todayKey: currentDay,
    secondsToday:
      (rollover ? 0 : Math.max(0, Number(vitals.secondsToday || 0))) +
      elapsedSeconds,
    secondsTotal:
      Math.max(0, Number(vitals.secondsTotal || 0)) + elapsedSeconds,
    today: {
      ...(rollover
        ? {
            energyDelta: 0,
            initiativeDelta: 0,
            relationshipDelta: 0,
            interactions: 0,
            petCount: 0
          }
        : vitals.today),
      energyDelta,
      initiativeDelta,
      relationshipDelta
    },
    lastSimulatedAt: new Date(now).toISOString()
  };
  const moodScore = calculateMoodScore(advanced, now);
  return { ...advanced, moodScore, mood: moodLabel(moodScore) };
}
