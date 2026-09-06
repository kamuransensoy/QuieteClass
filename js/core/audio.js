// audio.js
// Owns microphone capture and emits a smoothed, normalized (0-1) noise level.
// Knows nothing about noise states, sessions, themes, or the DOM.
// Audio is processed frame-by-frame in memory only — never recorded,
// stored, uploaded, or transmitted anywhere.

let audioContext = null;
let analyser = null;
let mediaStream = null;
let dataArray = null;
let rafId = null;
let smoothedLevel = 0;

// Monotonically-incrementing session token. Bumped by every stopAudio()
// call and claimed by every startAudio() call — the single mechanism that
// makes start/stop safe against two known races:
//   1. A pending getUserMedia() (awaited across a real async gap) resolving
//      AFTER stopAudio() already ran, which would otherwise silently
//      restart capture nobody asked for anymore.
//   2. onLevel() synchronously calling stopAudio() from inside tick() (as
//      session.js's handleLevel() does on win/fail) — tick() would
//      otherwise still reach its own requestAnimationFrame(tick) call and
//      reschedule itself once more, and that next frame would call
//      analyser.getByteTimeDomainData() on an analyser stopAudio() already
//      nulled out.
// Every check below compares a call's own captured token against this
// counter — any stop, or any newer startAudio(), invalidates it.
let sessionToken = 0;

const SMOOTHING = 0.35; // exponential moving average factor (higher = more responsive)

function releaseResources() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  analyser = null;
  dataArray = null;
  smoothedLevel = 0;
}

/**
 * Requests microphone access and starts the analysis loop.
 * @param {(level: number) => void} onLevel - called every animation frame with a 0-1 level.
 * @returns {Promise<boolean>} true if mic access granted and loop started, false if denied/unavailable.
 */
export async function startAudio(onLevel) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return false; // microphone API unavailable in this browser/context
  }

  // A still-active previous session (start called again without an
  // intervening stop) is torn down first — no duplicate capture loops, no
  // orphaned stream left running alongside the new one.
  releaseResources();
  const myToken = ++sessionToken;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    return false; // permission denied or no device
  }

  if (myToken !== sessionToken) {
    // stopAudio() (or a newer startAudio()) ran while permission was
    // pending — this attempt is obsolete. Release the stream we just got
    // and never touch module state with it.
    stream.getTracks().forEach((track) => track.stop());
    return false;
  }

  let ctx;
  let liveAnalyser;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaStreamSource(stream);
    liveAnalyser = ctx.createAnalyser();
    liveAnalyser.fftSize = 512;
    source.connect(liveAnalyser);
  } catch (err) {
    stream.getTracks().forEach((track) => track.stop());
    try { ctx && ctx.close(); } catch { /* already unusable, nothing more to release */ }
    return false;
  }

  mediaStream = stream;
  audioContext = ctx;
  analyser = liveAnalyser;
  dataArray = new Uint8Array(analyser.fftSize);
  smoothedLevel = 0;

  const tick = () => {
    if (myToken !== sessionToken) return; // stopped/superseded since this frame was scheduled
    analyser.getByteTimeDomainData(dataArray);

    // Compute RMS of the time-domain waveform (samples centered at 128).
    let sumSquares = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const centered = (dataArray[i] - 128) / 128;
      sumSquares += centered * centered;
    }
    const rms = Math.sqrt(sumSquares / dataArray.length);
    const normalized = Math.min(1, rms * 4); // scale factor tuned for typical mic gain

    smoothedLevel = smoothedLevel + (normalized - smoothedLevel) * SMOOTHING;

    onLevel(smoothedLevel);
    // onLevel() may have synchronously called stopAudio() (session.js does
    // exactly this on win/fail) — re-check before scheduling the next
    // frame rather than unconditionally rescheduling.
    if (myToken === sessionToken) {
      rafId = requestAnimationFrame(tick);
    }
  };

  rafId = requestAnimationFrame(tick);
  return true;
}

/** Stops the analysis loop and releases the microphone (stops all tracks). */
export function stopAudio() {
  sessionToken++; // invalidate any in-flight startAudio() and any already-scheduled tick()
  releaseResources();
}
