// rocket/renderer.js
// Owns timing, easing, and per-frame property writes for the Rocket
// scene built once by scene.js. One rAF loop, frame-rate-independent,
// clamped dt. Never creates/removes DOM after mount(). All visual
// intensity is a continuous function of the Wake Meter (0-100) — this
// theme never receives raw microphone noiseState.
//
// Visual bands are tuned so 25/50/75/90/99 are each clearly distinct
// (see the final report for the worked-out values per channel):
// engine glow saturates by ~65%, while engine-core brightness and
// vibration keep intensifying all the way to 99%, so the "final warning"
// range still visibly escalates even after glow/vapor have maxed out.

import { buildScene } from "./rocket_scene.js";

const smoothstep = (edge0, edge1, x) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
const easeInCubic = (t) => t * t * t;
const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

const WRITE_EPSILON = 0.01;
const MAX_TICK_DT_MS = 100;

// Continuous progress -> intensity curves. One clearly named place to
// retune the Rocket's "feel" without touching layout/timing code.
const BANDS = {
  controlLights: [0.15, 0.40],
  engineGlow: [0.18, 0.65],
  engineCore: [0.55, 0.99],
  vibration: [0.45, 1.00],
  vapor: [0.20, 0.85],
  platformReact: [0.55, 0.95],
  clampStrain: [0.65, 1.00],
  flame: [0.78, 1.00],
};

// One-shot LAUNCH sequence, entirely procedural — this theme authors its
// own exact timeline, so completion is detected by elapsed time (not a
// guessed duration standing in for something external, unlike a video).
const LAUNCH_PHASES = [
  { name: "ignitionPeak", duration: 300, ease: easeOutCubic },
  { name: "compress", duration: 200, ease: easeInOutQuad },
  { name: "clampRelease", duration: 200, ease: easeOutCubic },
  { name: "liftoff", duration: 900, ease: easeInCubic },
  { name: "settle", duration: 500, ease: easeInOutQuad },
];
const LAUNCH_TOTAL_MS = LAUNCH_PHASES.reduce((sum, p) => sum + p.duration, 0);

let nodes = null;
let mounted = false;
let rafId = null;
let lastFrameTime = 0;
let ambientPhase = 0;

let targetProgress = 0;   // 0-1, set by updateProgress()
let currentProgress = 0;  // smoothed toward targetProgress every frame

let launchActive = false;
let launchStart = null;
let launchOnComplete = null;

let last = {}; // last-applied values, to skip redundant DOM writes

export function mount(stageEl) {
  nodes = buildScene(stageEl);
  mounted = true;
  ambientPhase = 0;
  targetProgress = 0;
  currentProgress = 0;
  launchActive = false;
  launchStart = null;
  last = {};
  lastFrameTime = performance.now();
  rafId = requestAnimationFrame(tick);
}

function changed(key, value) {
  if (last[key] === undefined || Math.abs(last[key] - value) > WRITE_EPSILON) {
    last[key] = value;
    return true;
  }
  return false;
}

function tick(now) {
  const dt = Math.min(now - lastFrameTime, MAX_TICK_DT_MS);
  lastFrameTime = now;
  ambientPhase += dt;

  const smoothing = 1 - Math.exp(-dt / 220);
  currentProgress += (targetProgress - currentProgress) * smoothing;

  if (launchActive) {
    renderLaunch(now);
  } else {
    renderAmbient();
  }

  rafId = requestAnimationFrame(tick);
}

// --- Ambient (0-99%): continuous, no discrete visual cuts -----------------

function renderAmbient() {
  const p = currentProgress;
  const t = ambientPhase / 1000;

  const controlLights = smoothstep(...BANDS.controlLights, p);
  const engineGlow = smoothstep(...BANDS.engineGlow, p);
  const engineCore = smoothstep(...BANDS.engineCore, p);
  const vibration = smoothstep(...BANDS.vibration, p);
  const vapor = smoothstep(...BANDS.vapor, p);
  const platformReact = smoothstep(...BANDS.platformReact, p);
  const clampStrain = smoothstep(...BANDS.clampStrain, p);
  const flame = smoothstep(...BANDS.flame, p);

  if (changed("engineGlow", engineGlow)) {
    nodes.rocket.engineGlow.style.opacity = engineGlow.toFixed(3);
  }
  if (changed("engineCore", engineCore)) {
    const scale = 1 + engineCore * 0.55;
    const color = engineCore > 0.5 ? "#ffb14a" : "#3d4a6b";
    [nodes.rocket.nozzleMain].forEach((n) => {
      n.style.transform = `scale(${scale.toFixed(3)})`;
      n.setAttribute("fill", color);
    });
  }

  // Deterministic layered vibration — two incommensurate frequencies, tiny amplitude.
  const vib = (Math.sin(t * 37) * 0.6 + Math.sin(t * 71 + 1.3) * 0.4) * vibration * 1.8;
  if (changed("vibration", vib)) {
    nodes.rocket.group.style.transform = `translate(170px,296px) translate(${vib.toFixed(2)}px,0)`;
  }

  if (changed("vapor", vapor)) {
    nodes.vapor.group.style.setProperty("--vapor-peak", (0.15 + vapor * 0.45).toFixed(2));
    nodes.vapor.group.style.setProperty("--vapor-dur", `${(2.8 - vapor * 1.4).toFixed(2)}s`);
    nodes.vapor.group.style.opacity = Math.min(1, vapor + 0.05).toFixed(2);
  }

  if (changed("controlLights", controlLights)) {
    nodes.tower.lights.forEach((light) => { light.style.opacity = (0.2 + controlLights * 0.5).toFixed(2); });
  }

  if (changed("platformReact", platformReact)) {
    nodes.groundLight.left.style.opacity = platformReact.toFixed(2);
    nodes.groundLight.right.style.opacity = platformReact.toFixed(2);
    nodes.haze.style.opacity = (0.3 + platformReact * 0.7).toFixed(2);
  }

  const warnPulse = platformReact > 0.02 ? (Math.sin(t * (3 + platformReact * 6)) * 0.5 + 0.5) * platformReact : 0;
  if (changed("warn", warnPulse)) {
    const glow = (0.15 + warnPulse * 0.85).toFixed(2);
    nodes.clampL.light.style.opacity = glow;
    nodes.clampR.light.style.opacity = glow;
  }

  if (changed("clampStrain", clampStrain)) {
    const shake = clampStrain > 0.01 ? Math.sin(t * 53) * clampStrain * 1.3 : 0;
    nodes.clampL.group.style.transform = `rotate(${shake.toFixed(2)}deg)`;
    nodes.clampR.group.style.transform = `rotate(${(-shake).toFixed(2)}deg)`;
  }

  if (changed("flame", flame)) {
    nodes.flame.group.style.opacity = flame.toFixed(3);
    const s = (0.55 + flame * 0.55).toFixed(3);
    nodes.flame.group.style.transform = `translate(170px,360px) scale(${s})`;
  }
}

// --- Launch (100%, one-shot): eased phases, camera locked -----------------

function renderLaunch(now) {
  const elapsed = now - launchStart;
  if (elapsed >= LAUNCH_TOTAL_MS) {
    finishLaunch();
    return;
  }

  let acc = 0, phase = LAUNCH_PHASES[0], progress = 0;
  for (const p of LAUNCH_PHASES) {
    if (elapsed < acc + p.duration) { phase = p; progress = (elapsed - acc) / p.duration; break; }
    acc += p.duration;
  }
  const e = phase.ease(progress);

  let scaleY = 1, translateY = 0, flameScale = 1, flameOpacity = 1, clampOffset = 0;

  if (phase.name === "ignitionPeak") {
    nodes.rocket.engineGlow.style.opacity = "1";
    nodes.rocket.nozzleMain.style.transform = `scale(${(1.55 + e * 0.3).toFixed(3)})`;
    flameScale = 1.1 + e * 0.3;
    nodes.vapor.group.style.opacity = "1";
  } else if (phase.name === "compress") {
    scaleY = 1 - e * 0.04; // brief squash — "weight" before release
    flameScale = 1.4;
  } else if (phase.name === "clampRelease") {
    clampOffset = e * 16; // clamps swing outward and away
    scaleY = 0.96 + e * 0.04;
    flameScale = 1.4 + e * 0.4;
  } else if (phase.name === "liftoff") {
    translateY = -e * 540; // accelerating climb, well past the top of the viewBox
    flameScale = 1.8 + e * 1.5; // trailing exhaust stretches as it climbs
    clampOffset = 16;
  } else if (phase.name === "settle") {
    translateY = -540;
    flameOpacity = 1 - e;
    nodes.vapor.group.style.opacity = String(1 - e * 0.6);
    nodes.groundLight.left.style.opacity = String((1 - e) * 0.5);
    nodes.groundLight.right.style.opacity = String((1 - e) * 0.5);
    clampOffset = 16;
  }

  nodes.rocket.group.style.transform = `translate(170px,${296 + translateY}px) scaleY(${scaleY.toFixed(3)})`;
  nodes.flame.group.style.transform = `translate(170px,${360 + translateY}px) scale(${flameScale.toFixed(3)})`;
  nodes.flame.group.style.opacity = flameOpacity.toFixed(3);
  nodes.clampL.group.style.transform = `translate(${-clampOffset.toFixed(2)}px,0)`;
  nodes.clampR.group.style.transform = `translate(${clampOffset.toFixed(2)}px,0)`;
}

function finishLaunch() {
  launchActive = false;
  const cb = launchOnComplete;
  launchOnComplete = null;
  if (cb) cb();
}

// --- Contract ---------------------------------------------------------

export function updateProgress(wakeMeter) {
  targetProgress = Math.max(0, Math.min(1, wakeMeter / 100));
  // While launching, ambient rendering is skipped entirely (see tick()),
  // so there's nothing to "store only" — the launch sequence owns every
  // visual write until it reports completion.
}

export function triggerFailEvent(onComplete) {
  if (!mounted || launchActive) return; // fires once; ignore re-entry while already playing
  launchActive = true;
  launchStart = performance.now();
  launchOnComplete = onComplete || null;
}

export function resolveFailEvent() {
  // Intentional no-op: the launch sequence always finishes on its own
  // fixed timeline (see LAUNCH_TOTAL_MS) — nothing external can resolve
  // it early, and nothing needs to.
}

export function onSessionEnd() {
  if (!mounted) return;
  launchActive = false;
  launchOnComplete = null;
  targetProgress = 0;
  currentProgress = 0;
}

export function unmount(stageEl) {
  if (!mounted) return;
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  if (nodes && nodes.svg && stageEl.contains(nodes.svg)) stageEl.removeChild(nodes.svg);
  nodes = null;
  mounted = false;
  launchActive = false;
  launchOnComplete = null;
}
