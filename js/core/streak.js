// streak.js
// Class Streak: the smallest persistence appropriate for one small MVP
// counter — localStorage only, no database, no new persistence
// architecture. Theme-agnostic core gameplay state, not tied to Rocket or
// any other mission. Every read is validated so a corrupted/tampered
// stored value can never produce a negative or non-integer streak.

const STORAGE_KEY = "quietclass.classStreak";

function readStoredStreak() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const n = Math.floor(Number(raw));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0; // storage unavailable (private browsing, sandboxed context, etc.)
  }
}

function writeStoredStreak(value) {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Non-fatal: streak simply won't persist across reloads in this context.
  }
}

/** Current persisted Class Streak, validated. Safe to call any time. */
export function getClassStreak() {
  return readStoredStreak();
}

/**
 * Records exactly one mission's outcome. Call this ONCE per resolved
 * mission, at the moment the result is locked — never per render, never
 * on Play Again/Choose New Mission (those don't produce a new result).
 * @param {boolean} won
 * @returns {{ previousStreak: number, newStreak: number }}
 */
export function recordMissionOutcome(won) {
  const previousStreak = readStoredStreak();
  const newStreak = won ? previousStreak + 1 : 0;
  writeStoredStreak(newStreak);
  return { previousStreak, newStreak };
}
