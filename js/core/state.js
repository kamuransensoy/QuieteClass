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
  remainingSeconds: 300,             // mission countdown, counts down to 0
  result: null,                        // null | 'win' | 'fail'
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
