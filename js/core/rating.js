// rating.js
// Pure derivation of the 3-star Mission Rating from a session's peak Wake
// Meter value. Theme-agnostic, core gameplay logic — no DOM, no session
// lifecycle, no knowledge that "Rocket" or "Dragon" exist. Observes the
// Wake Meter; never influences it.

// Centralized thresholds so tuning never requires touching UI code.
// peakWakeMeter < PERFECT_MAX      -> 3 stars
// PERFECT_MAX <= peak < GREAT_MAX  -> 2 stars
// GREAT_MAX <= peak < 100          -> 1 star
// failed (wakeMeter reached 100)   -> 0 stars
export const RATING_THRESHOLDS = {
  PERFECT_MAX: 30,
  GREAT_MAX: 60,
};

/**
 * @param {number} peakWakeMeter - the highest Wake Meter value reached during the session (0-100).
 * @param {boolean} failed - true if the mission ended in a launch (Wake Meter reached 100).
 * @returns {{ stars: 0 | 1 | 2 | 3 }}
 */
export function getMissionRating(peakWakeMeter, failed) {
  if (failed) return { stars: 0 };
  if (peakWakeMeter < RATING_THRESHOLDS.PERFECT_MAX) return { stars: 3 };
  if (peakWakeMeter < RATING_THRESHOLDS.GREAT_MAX) return { stars: 2 };
  return { stars: 1 };
}
