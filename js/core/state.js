// state.js
// Single source of truth for the app. Flat object + pub/sub.
// No DOM, no audio, no theme logic lives here.

const state = {
  status: "idle",          // 'idle' | 'micDenied' | 'running' | 'paused' | 'ended'
  noiseLevel: 0,             // normalized 0-1, smoothed (internal — drives Wake Meter velocity only)
  noiseState: "CALM",        // raw mic classification (internal — never forwarded to a theme directly)
  wakeMeter: 0,                // 0-100, accumulated classroom-noise danger for the current mission.
                                // This is the ONLY progress signal themes receive — see themeRegistry.js.
  locked: false,                 // true once win/fail has been decided; disables Pause/End
  selectedDurationSeconds: 300,    // teacher's chosen mission length (default 5 min)
  voiceLevel: 0,                    // teacher's chosen Voice Level (0-3, default Silent) — not yet mapped to sensitivity
  remainingSeconds: 300,             // mission countdown, counts down to 0
  result: null,                        // null | 'win' | 'fail'
  peakWakeMeter: 0,                     // highest wakeMeter reached this mission — drives Mission Rating (rating.js); never decreases mid-mission
  resultStreak: null,                    // {previousStreak, newStreak} computed once when the result locks — null until then
};

const listeners = new Set();

export function getState() {
  return { ...state };
}

export function setState(partial) {
  Object.assign(state, partial);
  for (const listener of listeners) {
    listener(getState());
  }
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
