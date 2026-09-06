// dragon/renderer_pose.js
// PRESERVED FALLBACK — the original PNG-state + GSAP Dragon renderer,
// QA-approved and kept working exactly as-is. dragon_renderer.js (the new
// production entry point) is a thin frame-timeline renderer with a
// dispatcher that falls back to this implementation if frame-asset
// loading fails badly (see dragon_renderer.js's header for the contract).
// This file's own logic is otherwise unmodified.
//
// Four static character poses
// (assets/dragon/dragon_{sleeping,alert,angry,failure}.png, cleaned to
// real alpha — see the project's asset-cleanup notes) are cross-faded
// continuously against the shared Wake Meter (0-100), rather than the
// old renderer's discrete video-bucket switching. No video, no SVG live
// rendering, no RAF loop of our own — GSAP owns all animation.
//
// DOM nesting (three independent transform layers per pose, so nothing
// ever fights over the same GSAP property):
//   .dragon-stage
//     .dragon-environment            (static CSS cave, built once)
//     .dragon-character              (shake/impact transform only)
//       .dragon-pose.dragon-pose-*   (presence: opacity/xPercent/yPercent/scaleX/scaleY, driven by Wake Meter)
//         .dragon-pose-img           (idle life: x/y/rotation/scaleY breathing, always-looping GSAP timelines)
//       .dragon-glow                 (runtime warm glow, opacity-only)
//       .dragon-smoke / .dragon-fire (small pooled runtime elements)
//     .dragon-flash                  (full-stage impact flash)
//
// All four .dragon-pose-* anchors share one coordinate system: .dragon-
// character is locked to the PNGs' own 1408:768 aspect ratio (via CSS
// aspect-ratio), so percentage positioning means the same thing for every
// layer — no image independently determines its own layout.

import { gsap } from "../../vendor/gsap-esm.js";

const POSES = ["sleeping", "alert", "angry", "failure"];
const IMG_SRC = {
  sleeping: "assets/dragon/dragon_sleeping.png",
  alert: "assets/dragon/dragon_alert.png",
  angry: "assets/dragon/dragon_angry.png",
  failure: "assets/dragon/dragon_failure.png",
};

// Canvas aspect ratio shared by all four PNGs (1408x768) — anchors
// .dragon-character's own box shape so every pose/effect position means
// the same thing in every layer (see file header).
const CANVAS_ASPECT = "1408 / 768";

// Wake Meter (0-100) -> visual blend ranges. VISUAL ONLY: never read by
// session.js/rating.js — this theme's own interpretation of the one
// number core hands over via updateProgress(), same as the old renderer's
// bucket thresholds were.
const RANGES = {
  sleepToAlertStart: 25,
  sleepToAlertEnd: 45,
  alertToAngryStart: 55,
  alertToAngryEnd: 75,
  tensionStart: 70,     // angry idle shake begins ramping here
  tensionEnd: 99,
  finalWarningStart: 95, // mouth/chest glow + nostril smoke
  finalWarningEnd: 99,
};

// Per-pose resting position/scale, centralized rather than scattered
// magic numbers — small corrective offsets (a few % at most) derived by
// measuring each PNG's actual visible bounding box (the four poses do
// NOT share identical bounds even though they share canvas size) so the
// dragon's perceived anatomy/position stays consistent across states.
// Values are GSAP xPercent/yPercent/scale on the .dragon-pose-* anchor.
const POSE_LAYOUT = {
  sleeping: { x: 2, y: -1.5, scale: 1.02 },
  alert: { x: -4.5, y: -1, scale: 0.95 },
  angry: { x: 0, y: 1.5, scale: 1.0 },
  failure: { x: 1, y: 0.5, scale: 0.98 },
};

// Per-pose "entrance bias": how far below its resting spot (yPercent) and
// how much smaller (scale) a pose starts before it's fully present, i.e.
// as its own crossfade weight rises from 0->1. This is what makes
// Sleeping->Alert read as "lifting itself awake" and Alert->Angry read as
// "growing taller/tenser", as a single general rule applied per-pose
// rather than special-cased per transition pair.
const POSE_MOTION = {
  sleeping: { enterDY: 1.2, enterScale: 0.99 },
  alert: { enterDY: 2.6, enterScale: 0.965 },
  angry: { enterDY: 2.0, enterScale: 0.958 },
  failure: { enterDY: 0, enterScale: 1 }, // driven entirely by the fail cinematic instead
};

// Canvas-normalized (% of the 1408x768 image) anchor points, measured
// visually against each pose's own artwork — where the face/mouth
// actually sits in THAT pose, not a shared guess.
const ANGRY_FACE_ANCHOR = { x: 38, y: 24 };
const FAILURE_MOUTH_ANCHOR = { x: 34, y: 40 };

function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Dragon's own mapping from the shared Wake Meter to three overlapping
// pose weights (always summing to 1 pre-failure) — the continuous
// equivalent of the old renderer's discrete CALM/LOW/MEDIUM/HIGH buckets.
function computeWeights(m) {
  const s2a = smoothstep(RANGES.sleepToAlertStart, RANGES.sleepToAlertEnd, m);
  const a2an = smoothstep(RANGES.alertToAngryStart, RANGES.alertToAngryEnd, m);
  return {
    sleeping: 1 - s2a,
    alert: s2a * (1 - a2an),
    angry: a2an,
  };
}

let mounted = false;
let stageRoot = null;
let els = null; // DOM references, see buildDom()
let quickSetters = null; // per-pose {opacity,scaleX,scaleY,yPercent} quickTo functions
let idleTimelines = null; // per-pose idle GSAP timelines (always running, see mount())
let angryIntensity = null; // {v:0} plain object tweened smoothly, read by the angry idle timeline
let glowQuick = null; // quickTo for the final-warning glow's opacity
let intensityQuick = null; // quickTo for angryIntensity.v — created once, reused every updateProgress
let smokeQuick = null; // quickTo for the nostril-smoke puffs' opacity
let failTimeline = null;
let failEventActive = false;
let lastWakeMeter = 0;

function buildDom(stageEl) {
  const root = document.createElement("div");
  root.className = "dragon-stage";

  const environment = document.createElement("div");
  environment.className = "dragon-environment";
  environment.innerHTML = `
    <div class="dragon-env-cave"></div>
    <div class="dragon-env-glow"></div>
    <div class="dragon-ground-shadow"></div>
  `;

  const character = document.createElement("div");
  character.className = "dragon-character";

  const poseEls = {};
  const imgEls = {};
  POSES.forEach((pose) => {
    const anchor = document.createElement("div");
    anchor.className = `dragon-pose dragon-pose-${pose}`;
    const img = document.createElement("img");
    img.className = "dragon-pose-img";
    img.src = IMG_SRC[pose];
    img.alt = "";
    img.draggable = false;
    anchor.appendChild(img);
    character.appendChild(anchor);
    poseEls[pose] = anchor;
    imgEls[pose] = img;
  });

  const glow = document.createElement("div");
  glow.className = "dragon-glow";

  const smokePool = document.createElement("div");
  smokePool.className = "dragon-smoke-pool";
  smokePool.innerHTML = `
    <span class="dragon-smoke-puff dragon-smoke-puff-1"></span>
    <span class="dragon-smoke-puff dragon-smoke-puff-2"></span>
  `;

  const firePool = document.createElement("div");
  firePool.className = "dragon-fire-pool";
  for (let i = 0; i < 5; i++) {
    const blob = document.createElement("span");
    blob.className = "dragon-fire-blob";
    firePool.appendChild(blob);
  }

  character.appendChild(glow);
  character.appendChild(smokePool);
  character.appendChild(firePool);

  const flash = document.createElement("div");
  flash.className = "dragon-flash";

  root.appendChild(environment);
  root.appendChild(character);
  root.appendChild(flash);
  stageEl.appendChild(root);

  return {
    root,
    character,
    poseEls,
    imgEls,
    glow,
    smokePuffs: Array.from(smokePool.querySelectorAll(".dragon-smoke-puff")),
    fireBlobs: Array.from(firePool.querySelectorAll(".dragon-fire-blob")),
    flash,
  };
}

function buildIdleTimelines() {
  const timelines = {};

  // Sleeping: subtle breathing — scaleY only, bottom-anchored so it reads
  // as a chest rising, not the whole sprite floating. ~3.2s sine.
  timelines.sleeping = gsap.timeline({ repeat: -1, yoyo: true })
    .to(els.imgEls.sleeping, {
      scaleY: 1.012,
      transformOrigin: "50% 100%",
      duration: 1.6,
      ease: "sine.inOut",
    });

  // Alert: calmer than angry — small sway + gentle breathing.
  timelines.alert = gsap.timeline({ repeat: -1, yoyo: true })
    .to(els.imgEls.alert, {
      rotation: 0.6,
      scaleY: 1.006,
      transformOrigin: "50% 90%",
      duration: 2.1,
      ease: "sine.inOut",
    });

  // Angry: idle tension jitter. Amplitude is driven by angryIntensity.v
  // (0-1, smoothly tweened from updateProgress) via function-based
  // values — the SAME persistent timeline gets more intense over time,
  // never a newly-constructed timeline per Wake Meter update.
  timelines.angry = gsap.timeline({ repeat: -1 });
  for (let i = 0; i < 8; i++) {
    timelines.angry.to(els.imgEls.angry, {
      duration: () => 0.16 + Math.random() * 0.12,
      x: () => (Math.random() * 2 - 1) * 3.2 * angryIntensity.v,
      y: () => (Math.random() * 2 - 1) * 1.6 * angryIntensity.v,
      rotation: () => (Math.random() * 2 - 1) * 0.9 * angryIntensity.v,
      ease: "sine.inOut",
    });
  }

  return timelines;
}

export function mount(stageEl) {
  els = buildDom(stageEl);
  stageRoot = els.root;
  mounted = true;
  failEventActive = false;
  failTimeline = null;
  lastWakeMeter = 0;

  angryIntensity = { v: 0 };

  quickSetters = {};
  POSES.forEach((pose) => {
    const anchor = els.poseEls[pose];
    const layout = POSE_LAYOUT[pose];
    gsap.set(anchor, {
      xPercent: layout.x,
      yPercent: layout.y,
      scaleX: layout.scale,
      scaleY: layout.scale,
      opacity: pose === "sleeping" ? 1 : 0,
      transformOrigin: "50% 50%",
    });
    quickSetters[pose] = {
      opacity: gsap.quickTo(anchor, "opacity", { duration: 0.5, ease: "sine.out" }),
      scaleX: gsap.quickTo(anchor, "scaleX", { duration: 0.5, ease: "sine.out" }),
      scaleY: gsap.quickTo(anchor, "scaleY", { duration: 0.5, ease: "sine.out" }),
      yPercent: gsap.quickTo(anchor, "yPercent", { duration: 0.5, ease: "sine.out" }),
    };
  });

  gsap.set(els.glow, {
    left: `${ANGRY_FACE_ANCHOR.x}%`,
    top: `${ANGRY_FACE_ANCHOR.y}%`,
    opacity: 0,
  });
  glowQuick = gsap.quickTo(els.glow, "opacity", { duration: 0.6, ease: "sine.out" });
  intensityQuick = gsap.quickTo(angryIntensity, "v", { duration: 0.6, ease: "sine.out" });
  // One quickTo per puff (quickTo is designed for a single target) rather
  // than one shared call across the array.
  smokeQuick = els.smokePuffs.map((puff) => gsap.quickTo(puff, "opacity", { duration: 0.6, ease: "sine.out" }));

  gsap.set(els.smokePuffs, { opacity: 0 });
  gsap.set(els.fireBlobs, { opacity: 0, scale: 0.2 });
  gsap.set(els.flash, { opacity: 0 });
  gsap.set(els.character, { x: 0, y: 0 });

  idleTimelines = buildIdleTimelines();

  applyWeights(computeWeights(0));
}

function applyWeights(weights) {
  POSES.filter((p) => p !== "failure").forEach((pose) => {
    const weight = weights[pose];
    const motion = POSE_MOTION[pose];
    const layout = POSE_LAYOUT[pose];
    const enterT = 1 - weight;
    const scale = layout.scale * (motion.enterScale + (1 - motion.enterScale) * weight);
    const yPercent = layout.y + motion.enterDY * enterT;

    quickSetters[pose].opacity(weight);
    quickSetters[pose].scaleX(scale);
    quickSetters[pose].scaleY(scale);
    quickSetters[pose].yPercent(yPercent);
  });
}

// The ONLY progress signal this theme receives from core: the shared
// Wake Meter (0-100). Everything below is Dragon's own visual
// interpretation of that number — core never knows poses/ranges exist.
export function updateProgress(wakeMeter) {
  if (!mounted) return;
  lastWakeMeter = wakeMeter;
  if (failEventActive) return; // never fight the fail cinematic's own tweens

  applyWeights(computeWeights(wakeMeter));

  const tension = smoothstep(RANGES.tensionStart, RANGES.tensionEnd, wakeMeter);
  intensityQuick(tension);

  const finalWarning = smoothstep(RANGES.finalWarningStart, RANGES.finalWarningEnd, wakeMeter);
  glowQuick(finalWarning * 0.85);
  smokeQuick.forEach((fn) => fn(finalWarning * 0.6));
}

function killIdleTimelines() {
  if (!idleTimelines) return;
  Object.values(idleTimelines).forEach((tl) => tl.kill());
  idleTimelines = null;
}

export function triggerFailEvent(onComplete) {
  if (!mounted || failEventActive) return; // fires once; ignore re-entry while already playing
  failEventActive = true;

  const angryAnchor = els.poseEls.angry;
  const failureAnchor = els.poseEls.failure;
  const failureLayout = POSE_LAYOUT.failure;

  gsap.set(els.glow, { left: `${FAILURE_MOUTH_ANCHOR.x}%`, top: `${FAILURE_MOUTH_ANCHOR.y}%` });
  gsap.set(els.fireBlobs, {
    left: `${FAILURE_MOUTH_ANCHOR.x}%`,
    top: `${FAILURE_MOUTH_ANCHOR.y}%`,
    opacity: 0,
    scale: 0.2,
  });

  const onCompleteOnce = () => {
    failTimeline = null;
    failEventActive = false;
    if (onComplete) onComplete();
  };

  failTimeline = gsap.timeline({ onComplete: onCompleteOnce });

  // PHASE 1 — anticipation: angry briefly compresses/pulls back.
  failTimeline
    .to(angryAnchor, { scaleX: "-=0.04", scaleY: "-=0.04", xPercent: "-=1.5", duration: 0.2, ease: "sine.in" }, 0)

    // PHASE 2 — wake: crossfade to the failure pose, which comes forward
    // (scales up slightly) — wings read as dramatically larger purely
    // from the pose itself, no extra scale trickery needed.
    .to(angryAnchor, { opacity: 0, duration: 0.3, ease: "power1.in" }, 0.2)
    .fromTo(failureAnchor,
      { opacity: 0, scaleX: failureLayout.scale * 0.94, scaleY: failureLayout.scale * 0.94 },
      { opacity: 1, scaleX: failureLayout.scale * 1.03, scaleY: failureLayout.scale * 1.03, duration: 0.35, ease: "power2.out" },
      0.25)

    // PHASE 3 — mouth energy: warm glow at the failure pose's mouth.
    .to(els.glow, { opacity: 1, duration: 0.3, ease: "sine.out" }, 0.5)

    // PHASE 4 — fire burst: stylized cartoon blobs fan out from the mouth.
    .to(els.fireBlobs, {
      opacity: 1,
      scale: 1,
      x: (i) => [0, 22, -14, 40, -30][i],
      y: (i) => [-6, -22, -20, -4, -16][i],
      duration: 0.4,
      ease: "back.out(1.6)",
      stagger: 0.03,
    }, 0.75)
    .to(els.fireBlobs, { opacity: 0, duration: 0.35, ease: "power1.in" }, 1.25)

    // PHASE 5 — impact: brief stage shake + warm flash.
    .to(els.flash, { opacity: 0.32, duration: 0.08 }, 0.85)
    .to(els.flash, { opacity: 0, duration: 0.3 }, 0.93)
    .to(els.character, { x: 10, duration: 0.045, ease: "power1.inOut" }, 0.85)
    .to(els.character, { x: -9, duration: 0.05, ease: "power1.inOut" }, 0.895)
    .to(els.character, { x: 6, duration: 0.05, ease: "power1.inOut" }, 0.945)
    .to(els.character, { x: 0, y: 0, duration: 0.08, ease: "power1.out" }, 0.995)

    // PHASE 6 — complete: let the failure pose settle, then finish once.
    .to(failureAnchor, { scaleX: failureLayout.scale, scaleY: failureLayout.scale, duration: 0.3, ease: "power1.out" }, 1.1)
    .to(els.glow, { opacity: 0, duration: 0.5, ease: "sine.in" }, 1.4);
}

export function resolveFailEvent() {
  // Intentional no-op: the fail cinematic always finishes on its own
  // GSAP timeline (see triggerFailEvent's onComplete). session.js remains
  // the source of truth for when a new fail event is allowed to fire.
}

export function onSessionEnd() {
  if (!mounted) return;
  if (failTimeline) {
    failTimeline.kill();
    failTimeline = null;
  }
  failEventActive = false;
  angryIntensity.v = 0;
  gsap.set(els.glow, { opacity: 0 });
  gsap.set(els.smokePuffs, { opacity: 0 });
  gsap.set(els.fireBlobs, { opacity: 0 });
  gsap.set(els.flash, { opacity: 0 });
  gsap.set(els.character, { x: 0, y: 0 });
  applyWeights(computeWeights(0)); // pristine Sleeping for the next mission (Play Again included)
}

export function unmount(stageEl) {
  if (!mounted) return;
  mounted = false;

  if (failTimeline) {
    failTimeline.kill();
    failTimeline = null;
  }
  killIdleTimelines();
  // quickTo functions manage an underlying tween on their target+property
  // internally — killTweensOf() on every target covers those too, so
  // there's nothing extra to kill via quickSetters/glowQuick/etc. directly.
  gsap.killTweensOf([
    els.glow, ...els.smokePuffs, ...els.fireBlobs, els.flash, els.character,
    ...Object.values(els.poseEls), ...Object.values(els.imgEls),
    angryIntensity,
  ]);

  if (stageRoot && stageEl.contains(stageRoot)) stageEl.removeChild(stageRoot);

  stageRoot = null;
  els = null;
  quickSetters = null;
  angryIntensity = null;
  glowQuick = null;
  intensityQuick = null;
  smokeQuick = null;
  failEventActive = false;
  lastWakeMeter = 0;
}
