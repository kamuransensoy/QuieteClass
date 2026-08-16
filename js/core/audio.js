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

const SMOOTHING = 0.35; // exponential moving average factor (higher = more responsive)

/**
 * Requests microphone access and starts the analysis loop.
 * @param {(level: number) => void} onLevel - called every animation frame with a 0-1 level.
 * @returns {Promise<boolean>} true if mic access granted and loop started, false if denied/unavailable.
 */
export async function startAudio(onLevel) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return false; // microphone API unavailable in this browser/context
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    return false; // permission denied or no device
  }

  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(mediaStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
  } catch (err) {
    stopAudio();
    return false;
  }

  dataArray = new Uint8Array(analyser.fftSize);
  smoothedLevel = 0;

  const tick = () => {
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
    rafId = requestAnimationFrame(tick);
  };

  rafId = requestAnimationFrame(tick);
  return true;
}

/** Stops the analysis loop and releases the microphone (stops all tracks). */
export function stopAudio() {
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
