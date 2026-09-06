// dragon/renderer_frames.js
// Production Dragon renderer: a reversible 20fps frame timeline driven
// continuously by the shared Wake Meter, PLUS a forward-playing failure
// cinematic — both timelines sourced from the SAME Kling video
// (assets/dragon/source/dragon_wake_kling_v2.mp4), split into two frame
// sequences at the moment the dragon commits to its attack:
//
//   assets/dragon/timeline/wake/frame_0000.webp .. frame_0226.webp
//     sleeping -> fully awake/angry/charged (mouth still closed).
//     Reversible: Wake Meter 0-99 maps onto this range in both directions.
//
//   assets/dragon/timeline/fail/frame_0000.webp .. frame_0042.webp
//     mouth opens -> committed fire-breathing attack. Forward-only,
//     played once by triggerFailEvent() and never touched by
//     updateProgress().
//
// Frames were extracted via ffmpeg (chromakey + despill on the source
// video's green-screen background, watermark masked out, scaled to
// 960px width) — see the project's asset-cleanup notes. No <video>, no
// currentTime seeking, no sprite atlas — one PixiJS Sprite whose
// .texture is swapped as the (smoothed) frame index changes.
//
// Frame caching: the WAKE range uses a WINDOWED cache — only
// [current ± WINDOW_SIZE] stays decoded — adapted from the
// windowed-cache design validated in experiments/dragon-frame-poc/ onto
// PixiJS's own Assets load()/unload() reference-counted cache. Frame 0
// is a permanent exception — always resident — so Sleeping never blanks
// and replay/reselect is instant. The much shorter FAIL range is instead
// fully preloaded (prefetched in the background once the Wake Meter
// enters the tension zone, so it's normally already warm by the time
// triggerFailEvent() actually fires) since it only ever plays once,
// forward, per mission.
//
// Not accessed directly by app.js — dragon_renderer.js is the theme's
// real entry point and dispatches here (falling back to
// dragon_renderer_pose.js if even frame 0 fails to load).

import { ensurePixiLoaded } from "../../core/pixiLoader.js";
import { gsap } from "../../vendor/gsap-esm.js";

const WAKE_FRAME_COUNT = 227;
const WAKE_FRAME_DIR = "assets/dragon/timeline/wake";
const FAIL_FRAME_COUNT = 43;
const FAIL_FRAME_DIR = "assets/dragon/timeline/fail";
const FAIL_FPS = 20;
// Local index (within the FAIL range) where the video's flame first
// becomes visible — measured against the source footage — used to time
// the impact flash/shake/lighting beat to the actual ignition rather
// than a guessed offset.
const FAIL_IGNITION_FRAME = 2;

const FRAME_W = 960;
const FRAME_H = 480;

// Wake Meter (0-99) -> timeline progress (0-1) -> frame index. 100 is
// deliberately NOT part of this mapping — core calls triggerFailEvent()
// for that, and this renderer never infers failure from the frame index.
function wakeToProgress(wakeMeter) {
  return Math.max(0, Math.min(1, wakeMeter / 99));
}

// Renderer-local smoothing so tiny Wake Meter fluctuations don't cause
// frame jitter, and rapid classroom noise changes still feel responsive.
// Frame-rate independent (uses ticker deltaMS). Chosen from an automated
// 200/175/150/120ms comparison (qcDebugSetWakeMeter step sweeps + a noisy
// 88<->94 boundary-straddle sequence, sampled via qcDebugDragonStatus):
// 90%-settle time was ~455ms(200) / ~420ms(175) / ~353ms(150) / ~290ms(120),
// and frame-index direction reversals under noisy input were 4/6/6/6 —
// chatter increases once below 200ms but does NOT get worse again between
// 175, 150, and 120, so 120ms was the fastest candidate with no measured
// chatter cost beyond what 150/175 already have.
const SMOOTHING_MS = 120;

// Tension zone (glow) — same 90-99% Wake Meter range the previous
// pose renderer used, expressed here in progress-space (progress*99).
const TENSION_START = 90;
const TENSION_END = 99;

// Normalized (% of the 960x480 frame canvas) anchor for the tension
// glow — measured against the WAKE range's final ("charged") frame.
// Approximate; nudge visually if the glow doesn't sit on the face.
const ANGRY_FACE_ANCHOR = { x: 0.42, y: 0.4 };

// --- Visual polish pass: composition/environment tuning -----------------
// Character now sits noticeably smaller/farther into the scene than the
// original "fills almost the whole safe area" sizing (~20% smaller
// rendered footprint) — visually tuned against the art-direction
// reference, not a blind percentage. Center shifts slightly below true
// vertical middle so the den's atmosphere has room to read above it, and
// the stone dais has room to read below it.
const CHAR_TARGET_W_RATIO = 0.72;
const CHAR_TARGET_H_RATIO = 0.68;
const CHAR_Y_RATIO = 0.54; // 0.5 = exact vertical center; >0.5 = shifted down

// Platform/shadow vertical anchor, as a fraction of the character's own
// half-height below its center — i.e. "how far toward the bottom of the
// character's box the ground contact sits." Tuned visually, not derived,
// since it depends on how each pose's silhouette actually sits within
// its fixed frame canvas.
const PLATFORM_Y_RATIO = 0.3;

// Ambient embers — small bounded pool, reused every tick, never
// reallocated. Purely decorative; never confused with the failure fire.
const EMBER_COUNT = 12;

function wakeFrameUrl(i) {
  return `${WAKE_FRAME_DIR}/frame_${String(i).padStart(4, "0")}.webp`;
}
function failFrameUrl(i) {
  return `${FAIL_FRAME_DIR}/frame_${String(i).padStart(4, "0")}.webp`;
}
function smoothstep(e0, e1, x) {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// --- Windowed WAKE frame cache (module-level, survives across
// mount/unmount so Play Again / repeat Dragon missions never redundantly
// re-fetch what's still resident) ---
//
// Only [center-WINDOW_SIZE, center+WINDOW_SIZE] around the current frame
// stays decoded — adapted from the windowed-cache design validated in
// experiments/dragon-frame-poc/, but built directly on PixiJS's own
// Assets load()/unload() reference-counted cache rather than manual
// createImageBitmap()/.close() calls, so eviction actually releases the
// GPU-side texture through Pixi's normal resource lifecycle instead of a
// second, parallel bookkeeping system.
//
// Frame 0 is a permanent exception: it is never evicted, regardless of
// where the window currently sits. This is what makes onSessionEnd()'s
// return-to-Sleeping instant even after the class has spent the whole
// mission at high Wake Meter (which would otherwise have pushed frame 0
// out of a purely position-based window), and what makes a subsequent
// mount() (Play Again, or Dragon selected again later) show frame 0
// immediately with zero network/decode wait.
const WINDOW_SIZE = 15;
let textureCache = new Map(); // index -> PIXI.Texture, currently resident
let inFlight = new Map();     // index -> { wanted }, load in progress
let failedFrameIndices = new Set();
let lastWindowCenter = -1;

function frameIsResident(index) {
  return textureCache.has(index);
}

function findNearestCachedTexture(index) {
  for (let d = 1; d < WAKE_FRAME_COUNT; d++) {
    if (index - d >= 0 && textureCache.has(index - d)) return textureCache.get(index - d);
    if (index + d < WAKE_FRAME_COUNT && textureCache.has(index + d)) return textureCache.get(index + d);
  }
  return textureCache.get(0) || null; // frame 0 is always resident — ultimate fallback
}

function loadOne(index) {
  if (textureCache.has(index)) return Promise.resolve(textureCache.get(index));
  const existing = inFlight.get(index);
  if (existing) return existing.promise;

  const entry = { wanted: true };
  const url = wakeFrameUrl(index);
  entry.promise = window.PIXI.Assets.load(url)
    .then((tex) => {
      inFlight.delete(index);
      if (!entry.wanted) {
        // Superseded by a later window move before this resolved — release
        // immediately via Pixi's own ref-counted unload rather than caching it.
        window.PIXI.Assets.unload(url).catch(() => {});
        return null;
      }
      textureCache.set(index, tex);
      return tex;
    })
    .catch((err) => {
      inFlight.delete(index);
      failedFrameIndices.add(index);
      console.error(`QuietClass Dragon: wake frame ${index} failed to load (${url}) — will use the nearest available frame instead.`, err);
      return null;
    });
  inFlight.set(index, entry);
  return entry.promise;
}

// Ensures [center-WINDOW_SIZE, center+WINDOW_SIZE] is (or will become)
// resident, evicting anything outside that range (except frame 0 and
// whatever's currently displayed) and kicking off loads for anything
// inside it that isn't cached yet, nearest-first. Precise per-frame
// cancellation — a small scrub mostly overlaps the previous window, so
// in-flight loads for frames that are STILL wanted are left alone rather
// than blanket-cancelled on every call (the cancel/reissue churn bug
// found and fixed in the original POC).
function ensureWindow(center) {
  const lo = Math.max(0, center - WINDOW_SIZE);
  const hi = Math.min(WAKE_FRAME_COUNT - 1, center + WINDOW_SIZE);
  const needed = new Set();
  for (let i = lo; i <= hi; i++) needed.add(i);

  for (const [idx] of textureCache) {
    if (!needed.has(idx) && idx !== currentFrameIndex && idx !== 0) {
      const tex = textureCache.get(idx);
      textureCache.delete(idx);
      window.PIXI.Assets.unload(wakeFrameUrl(idx)).catch(() => {});
      void tex; // Pixi owns the actual GPU release via unload(); nothing else to do here
    }
  }
  for (const [idx, entry] of inFlight) {
    if (!needed.has(idx)) entry.wanted = false;
  }

  const order = [center, ...needed].filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
  order.forEach((idx) => { if (!textureCache.has(idx)) loadOne(idx); });
}

let pixiReadyPromise = null;

/**
 * Prewarms frame 0 (and kicks off the rest of its initial neighborhood in
 * the background) so Dragon never shows a blank stage. Safe to call
 * multiple times/early (see dragon_theme.js's optional preload() hook,
 * called from app.js every time Dragon is selected on Setup) — mount()
 * awaits this same call rather than starting a separate load.
 *
 * Deliberately re-runs ensureWindow(0) on EVERY call rather than
 * memoizing the whole result: unmount() now releases frames 1-15 down to
 * just frame 0 (see the memory-tradeoff note on unmount()), so re-
 * selecting Dragon after visiting Rocket (or after a mission ends) needs
 * to re-warm that neighborhood again during Setup dwell time, not only
 * once per page session — memoizing the full result the way the original
 * one-shot preload did would silently skip that re-warm on every
 * selection after the first. Only the one-time PixiJS bootstrap itself
 * (ensurePixiLoaded()) is memoized. ensureWindow()/loadOne() are cheap
 * no-ops for anything already resident, so calling this repeatedly (e.g.
 * once per Setup card click) is inexpensive.
 *
 * Deliberately does NOT wait for the whole WAKE range (that would
 * reintroduce a full-cache memory footprint) — only frame 0 is awaited;
 * neighboring frames continue loading in the background. The much
 * shorter FAIL range is not touched here at all — it's prefetched later,
 * once the Wake Meter actually enters the tension zone (see
 * maybeStartFailPrefetch()).
 */
export function preload() {
  if (!pixiReadyPromise) pixiReadyPromise = ensurePixiLoaded();
  return pixiReadyPromise.then(async () => {
    ensureWindow(0);
    lastWindowCenter = 0;
    const frame0 = await loadOne(0);
    return { frame0Ready: !!frame0, failedCount: failedFrameIndices.size, total: WAKE_FRAME_COUNT };
  });
}

export function getLoadStatus() {
  return {
    frame0Resident: textureCache.has(0),
    failedCount: failedFrameIndices.size,
    total: WAKE_FRAME_COUNT,
  };
}

// Dev-only live telemetry (see window.qcDebugDragonStatus() in app.js).
// Never read by production UI or gameplay logic.
export function getDebugSnapshot() {
  return {
    mounted,
    currentFrameIndex,
    targetFrameIndex: Math.round(targetProgress * (WAKE_FRAME_COUNT - 1)),
    targetProgress: Number(targetProgress.toFixed(4)),
    visualProgress: Number(visualProgressState.v.toFixed(4)),
    tickerFPS: app ? Number(app.ticker.FPS.toFixed(1)) : null,
    failEventActive,
    cacheWindowSize: WINDOW_SIZE,
    residentTextureCount: textureCache.size,
    inFlightLoadCount: inFlight.size,
    failedFrameCount: failedFrameIndices.size,
    failFramesLoaded,
  };
}

// --- FAIL frame cache: small and short-lived enough to just fully
// preload rather than window — see file header. Prefetched in the
// background once the Wake Meter enters the tension zone so it's
// normally already warm by the time triggerFailEvent() actually fires;
// triggerFailEvent() also awaits it directly as a safety net for a Wake
// Meter that jumps straight to 100 without lingering in tension.
let failTextureCache = new Map();
let failFramesLoaded = false;
let failPreloadPromise = null;
let failPrefetchStarted = false;

function preloadFailFrames() {
  if (failFramesLoaded) return Promise.resolve();
  if (failPreloadPromise) return failPreloadPromise;
  failPreloadPromise = Promise.all(
    Array.from({ length: FAIL_FRAME_COUNT }, (_, i) =>
      window.PIXI.Assets.load(failFrameUrl(i))
        .then((tex) => { failTextureCache.set(i, tex); })
        .catch((err) => {
          console.error(`QuietClass Dragon: fail frame ${i} failed to load (${failFrameUrl(i)}).`, err);
        })
    )
  ).then(() => { failFramesLoaded = true; });
  return failPreloadPromise;
}

// --- Live renderer state ---
let mounted = false;
let app = null;
let environment = null;
let character = null;      // shake target
let spriteWrapper = null;  // idle-breathing transform target
let dragonSprite = null;
let glow = null;
let emberLayer = null;
let flash = null;
let sessionEl = null; // #screen-session — for the CSS fire-lit lighting boost (see triggerFailEvent)
let resizeHandler = null;
let idleTimeline = null;
let impactTimeline = null; // brief flash/shake/lighting beat synced to the fail sequence's ignition frame
let failEventActive = false;

let targetProgress = 0;
const visualProgressState = { v: 0 };
let currentFrameIndex = -1;
let baseCharX = 0;
let baseCharY = 0;

function makeSoftCircleTexture(PIXI, size, color) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, `rgba(${color}, 0.95)`);
  grad.addColorStop(0.6, `rgba(${color}, 0.45)`);
  grad.addColorStop(1, `rgba(${color}, 0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return PIXI.Texture.from(canvas);
}

// The big atmospheric background wash now lives in CSS on
// #screen-session (seamless across the whole screen, including the strip
// below the stage's own safe-area clip — see layout.css's "hard cut"
// fix). This function draws only what genuinely needs to move/scale
// with the character: a layered ground shadow + a low stone dais,
// centered under wherever layout() just placed the character. Redrawn
// only on layout() (mount + resize + onSessionEnd), not per-frame.
function drawPlatform(PIXI, charX, groundY, halfW) {
  environment.clear();

  const platformW = halfW * 2.05;
  const platformH = platformW * 0.16;

  // 1. Broad, very soft ambient shadow — the widest, faintest layer.
  environment.ellipse(charX, groundY, platformW * 0.62, platformH * 1.7).fill({ color: 0x000000, alpha: 0.22 });

  // 2. Low stone dais: a few concentric layers reading as "dark stone,
  //    warmly lit near the center" without a literal gradient fill API.
  environment.ellipse(charX, groundY, platformW * 0.5, platformH).fill({ color: 0x120c09, alpha: 0.9 });
  environment.ellipse(charX, groundY - platformH * 0.08, platformW * 0.42, platformH * 0.8).fill({ color: 0x1d140f, alpha: 0.85 });
  environment.ellipse(charX, groundY - platformH * 0.14, platformW * 0.3, platformH * 0.6).fill({ color: 0x3a2416, alpha: 0.65 });
  // Warm illumination near the dais center (reads as the ember-lit stone,
  // not a literal light source).
  environment.ellipse(charX, groundY - platformH * 0.1, platformW * 0.22, platformH * 0.45).fill({ color: 0x6b3f22, alpha: 0.55 });

  // 3. Restrained cracked-stone segmentation — a handful of short, subtle
  //    darker arcs, not a busy texture.
  const cracks = [
    { a0: 0.15, a1: 0.55, r: 0.46 },
    { a0: 2.3, a1: 2.7, r: 0.4 },
    { a0: 4.0, a1: 4.3, r: 0.47 },
  ];
  for (const c of cracks) {
    environment.moveTo(charX + Math.cos(c.a0) * platformW * c.r, groundY + Math.sin(c.a0) * platformH * c.r * 1.4);
    environment.lineTo(charX + Math.cos((c.a0 + c.a1) / 2) * platformW * (c.r - 0.05), groundY + Math.sin((c.a0 + c.a1) / 2) * platformH * (c.r - 0.05) * 1.4);
    environment.lineTo(charX + Math.cos(c.a1) * platformW * c.r, groundY + Math.sin(c.a1) * platformH * c.r * 1.4);
    environment.stroke({ width: 2, color: 0x030201, alpha: 0.65 });
  }

  // 4. Tight contact shadow directly beneath the character + a sliver of
  //    warm reflected light just above it.
  environment.ellipse(charX, groundY - platformH * 0.02, platformW * 0.24, platformH * 0.32).fill({ color: 0x000000, alpha: 0.4 });
  environment.ellipse(charX, groundY - platformH * 0.22, platformW * 0.2, platformH * 0.16).fill({ color: 0xc9793f, alpha: 0.1 });
}

// --- Ambient embers: a small, bounded, reused particle pool ------------
// Pure ambience, entirely separate from the failure cinematic — never
// allocated or destroyed per-frame, never mistaken for the video's own
// fire. Updated inline in tickProgress() (no second ticker), each
// ember's own position/alpha driven by simple per-frame math rather than
// a GSAP tween per particle.
let embers = [];
let emberBounds = { cx: 0, cy: 0, rx: 1, ry: 1 };
// Tweened up briefly during the failure cinematic ("embers become
// slightly more visible") and back down to 1 as it dissipates; see
// triggerFailEvent(). Left at 1 the rest of the time.
const emberIntensityState = { v: 1 };

function layoutEmberBounds(screenW, screenH, charX, groundY, halfW) {
  emberBounds = {
    cx: charX,
    cy: groundY - halfW * 0.55,
    rx: halfW * 1.15,
    ry: halfW * 0.62,
  };
}

function respawnEmber(e, initial) {
  const angle = Math.random() * Math.PI * 2;
  const r = Math.random();
  e.x = emberBounds.cx + Math.cos(angle) * emberBounds.rx * r;
  e.y = emberBounds.cy + Math.sin(angle) * emberBounds.ry * r;
  e.vx = (Math.random() - 0.5) * 6; // px/sec, gentle horizontal wander
  e.vy = -(8 + Math.random() * 14); // px/sec, slow upward drift
  e.wobbleSpeed = 0.4 + Math.random() * 0.6;
  e.wobblePhase = Math.random() * Math.PI * 2;
  e.maxLife = 2.5 + Math.random() * 3.5; // seconds
  e.life = initial ? Math.random() * e.maxLife : e.maxLife; // stagger initial spawn so they don't all pop in together
  e.baseScale = 0.5 + Math.random() * 0.9;
  e.baseAlpha = 0.25 + Math.random() * 0.35;
}

function buildEmbers(PIXI) {
  const tex = makeSoftCircleTexture(PIXI, 32, "255,171,90");
  embers = Array.from({ length: EMBER_COUNT }, () => {
    const sprite = new PIXI.Sprite(tex);
    sprite.anchor.set(0.5);
    const e = { sprite, x: 0, y: 0, vx: 0, vy: 0, wobbleSpeed: 0, wobblePhase: 0, life: 0, maxLife: 1, baseScale: 1, baseAlpha: 0.3 };
    respawnEmber(e, true);
    sprite.x = e.x;
    sprite.y = e.y;
    return e;
  });
  return embers.map((e) => e.sprite);
}

function updateEmbers(dtSec) {
  for (const e of embers) {
    e.life -= dtSec;
    if (e.life <= 0) respawnEmber(e, false);

    e.wobblePhase += dtSec * e.wobbleSpeed;
    e.x += (e.vx + Math.sin(e.wobblePhase) * 3) * dtSec;
    e.y += e.vy * dtSec;

    const t = 1 - e.life / e.maxLife; // 0 at spawn -> 1 at death
    const envelope = t < 0.15 ? t / 0.15 : t > 0.75 ? Math.max(0, (1 - t) / 0.25) : 1;
    const scaleWobble = 1 + Math.sin(e.wobblePhase * 1.7) * 0.12;

    e.sprite.x = e.x;
    e.sprite.y = e.y;
    e.sprite.alpha = e.baseAlpha * envelope * emberIntensityState.v;
    e.sprite.width = e.sprite.height = 5 * e.baseScale * scaleWobble;
  }
}

function layout() {
  if (!app) return;
  const screenW = app.screen.width;
  const screenH = app.screen.height;
  const targetW = screenW * CHAR_TARGET_W_RATIO;
  const targetH = screenH * CHAR_TARGET_H_RATIO;
  const scale = Math.min(targetW / FRAME_W, targetH / FRAME_H);

  character.x = baseCharX = screenW / 2;
  character.y = baseCharY = screenH * CHAR_Y_RATIO;
  spriteWrapper.scale.set(scale);

  const groundY = baseCharY + (FRAME_H / 2) * scale * PLATFORM_Y_RATIO;
  drawPlatform(window.PIXI, baseCharX, groundY, (FRAME_W / 2) * scale);
  layoutEmberBounds(screenW, screenH, baseCharX, groundY, (FRAME_W / 2) * scale);

  flash.clear();
  flash.rect(0, 0, screenW, screenH).fill(0xffb020);
  flash.alpha = 0;
}

function applyFrame(index, tex) {
  if (tex && dragonSprite) dragonSprite.texture = tex;
  currentFrameIndex = index;
}

function maybeStartFailPrefetch(wakeEquivalent) {
  if (failPrefetchStarted || wakeEquivalent < TENSION_START) return;
  failPrefetchStarted = true;
  preloadFailFrames();
}

function tickProgress(ticker) {
  const dtMs = ticker.deltaMS;
  updateEmbers(dtMs / 1000); // always runs, even during the fail cinematic — pure ambience, never gated on frame selection

  if (failEventActive) return; // never fight the fail cinematic's own frame stepping
  const alpha = 1 - Math.exp(-dtMs / SMOOTHING_MS);
  visualProgressState.v += (targetProgress - visualProgressState.v) * alpha;

  const frameIndex = Math.round(visualProgressState.v * (WAKE_FRAME_COUNT - 1));

  // Only re-evaluate the resident window when the target frame actually
  // changes — not every tick — matching the "cache movement" requirement
  // (avoid redundant load()/unload() churn for a center that hasn't moved).
  if (frameIndex !== lastWindowCenter) {
    ensureWindow(frameIndex);
    lastWindowCenter = frameIndex;
  }

  if (frameIndex !== currentFrameIndex) {
    if (frameIsResident(frameIndex)) {
      applyFrame(frameIndex, textureCache.get(frameIndex));
    } else if (failedFrameIndices.has(frameIndex)) {
      // Confirmed permanent failure (not just "still loading") — substitute
      // the nearest available frame now rather than waiting forever.
      applyFrame(frameIndex, findNearestCachedTexture(frameIndex));
    }
    // else: genuinely still decoding — stale-hold. Keep showing whatever
    // currentFrameIndex's texture already is; this same tick will pick the
    // new frame up automatically the moment it becomes resident, with no
    // separate polling loop.
  }

  const wakeEquivalent = visualProgressState.v * 99;
  const tension = smoothstep(TENSION_START, TENSION_END, wakeEquivalent);
  glow.alpha = tension * 0.8;
  maybeStartFailPrefetch(wakeEquivalent);
}

export async function mount(stageEl) {
  mounted = true;
  failEventActive = false;
  impactTimeline = null;
  targetProgress = 0;
  visualProgressState.v = 0;
  currentFrameIndex = -1;
  failPrefetchStarted = false;

  // preload() itself re-runs ensureWindow(0) on every call (see its own
  // comment) — if Setup already warmed the neighborhood this resolves
  // immediately; if not (e.g. Start Mission pressed before that finished,
  // or preload() was never called), this is where it happens instead,
  // using the countdown window as the fallback preload time.
  await preload();
  if (!mounted) return; // unmounted while awaiting

  const PIXI = window.PIXI;

  app = new PIXI.Application();
  await app.init({
    resizeTo: stageEl,
    backgroundAlpha: 0,
    antialias: true,
    resolution: Math.min(devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  if (!mounted) { app.destroy(true, { children: true, texture: false }); app = null; return; }

  app.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";
  stageEl.appendChild(app.canvas);

  environment = new PIXI.Graphics();
  character = new PIXI.Container();
  spriteWrapper = new PIXI.Container();
  dragonSprite = new PIXI.Sprite(textureCache.get(0) || PIXI.Texture.EMPTY);
  dragonSprite.anchor.set(0.5);
  dragonSprite.width = FRAME_W;
  dragonSprite.height = FRAME_H;

  const glowTex = makeSoftCircleTexture(PIXI, 256, "255,176,32");
  glow = new PIXI.Sprite(glowTex);
  glow.anchor.set(0.5);
  glow.width = glow.height = FRAME_W * 0.16;
  glow.alpha = 0;
  glow.x = (ANGRY_FACE_ANCHOR.x - 0.5) * FRAME_W;
  glow.y = (ANGRY_FACE_ANCHOR.y - 0.5) * FRAME_H;

  spriteWrapper.addChild(dragonSprite, glow);
  character.addChild(spriteWrapper);

  emberLayer = new PIXI.Container();
  emberLayer.addChild(...buildEmbers(PIXI));

  flash = new PIXI.Graphics();
  sessionEl = stageEl.parentElement;

  app.stage.addChild(environment, emberLayer, character, flash);

  resizeHandler = () => layout();
  app.renderer.on("resize", resizeHandler);
  layout();

  applyFrame(0, textureCache.get(0));
  startIdleBreathing();

  app.ticker.add(tickProgress);
}

function startIdleBreathing() {
  // Direct scale.y tween — no GSAP plugin needed (PixiPlugin isn't
  // vendored; Pixi's scale is a plain-numeric ObservablePoint, so core
  // GSAP can tween scale.y on it exactly like the failure cinematic's
  // impact shake already does elsewhere in this file).
  const baseY = spriteWrapper.scale.y;
  idleTimeline = gsap.timeline({ repeat: -1, yoyo: true })
    .to(spriteWrapper.scale, {
      y: baseY * 1.012,
      duration: 1.8,
      ease: "sine.inOut",
    });
}

// The ONLY progress signal this theme receives from core: the shared
// Wake Meter (0-100, though 100 is never passed here — see triggerFailEvent).
// Sets the target only; the ticker above owns smoothing/frame selection.
export function updateProgress(wakeMeter) {
  if (!mounted || failEventActive) return;
  targetProgress = wakeToProgress(wakeMeter);
}

// Plays the FAIL range forward at FAIL_FPS, swapping dragonSprite's
// texture directly (bypassing the WAKE windowed cache entirely — see
// failTextureCache above). Triggers a brief flash/shake/lighting beat
// once the video's own flame actually becomes visible, then calls
// onComplete exactly once the final frame has been shown for a beat.
function playFailSequence(onComplete) {
  let idx = 0;
  let acc = 0;
  const stepMs = 1000 / FAIL_FPS;
  let impactFired = false;

  applyFrame(0, failTextureCache.get(0));

  function triggerImpact() {
    impactFired = true;
    if (sessionEl) sessionEl.classList.add("dragon-fire-lit");
    impactTimeline = gsap.timeline({
      onComplete: () => { impactTimeline = null; },
    })
      .to(environment, { tint: 0xffddaa, duration: 0.15, ease: "sine.out" }, 0)
      .to(emberIntensityState, { v: 1.8, duration: 0.15 }, 0)
      .to(flash, { alpha: 0.16, duration: 0.08 }, 0)
      .to(flash, { alpha: 0, duration: 0.3 }, 0.08)
      .to(character, { x: baseCharX + 10, duration: 0.045, ease: "power1.inOut" }, 0)
      .to(character, { x: baseCharX - 9, duration: 0.05, ease: "power1.inOut" }, 0.045)
      .to(character, { x: baseCharX + 6, duration: 0.05, ease: "power1.inOut" }, 0.095)
      .to(character, { x: baseCharX, duration: 0.08, ease: "power1.out" }, 0.145)
      .to(environment, { tint: 0xffffff, duration: 0.4, ease: "sine.in" }, 0.5)
      .to(emberIntensityState, { v: 1, duration: 0.4 }, 0.5)
      .call(() => { if (sessionEl) sessionEl.classList.remove("dragon-fire-lit"); }, null, 0.9);
  }

  function step(ticker) {
    acc += ticker.deltaMS;
    while (acc >= stepMs && idx < FAIL_FRAME_COUNT - 1) {
      acc -= stepMs;
      idx += 1;
      applyFrame(idx, failTextureCache.get(idx));
      if (!impactFired && idx >= FAIL_IGNITION_FRAME) triggerImpact();
    }
    if (idx >= FAIL_FRAME_COUNT - 1) {
      app.ticker.remove(step);
      gsap.delayedCall(0.35, () => {
        failEventActive = false;
        if (onComplete) onComplete();
      });
    }
  }

  app.ticker.add(step);
}

export function triggerFailEvent(onComplete) {
  if (!mounted || failEventActive) return; // fires once; ignore re-entry while already playing
  failEventActive = true;
  // Idle breathing also tweens spriteWrapper.scale — pause it so it
  // doesn't fight the fail sequence's own frames. A fresh idle timeline
  // is created on the next mount() (Play Again), so there's nothing to
  // resume here.
  if (idleTimeline) idleTimeline.pause();
  gsap.to(glow, { alpha: 0, duration: 0.2, ease: "sine.in" });

  preloadFailFrames().then(() => {
    if (!mounted) return; // unmounted while awaiting the safety-net preload
    playFailSequence(onComplete);
  });
}

export function resolveFailEvent() {
  // Intentional no-op: the fail cinematic always finishes on its own
  // (see playFailSequence's onComplete). session.js remains the source
  // of truth for when a new fail event is allowed to fire.
}

export function onSessionEnd() {
  if (!mounted) return;
  if (impactTimeline) { impactTimeline.kill(); impactTimeline = null; }
  failEventActive = false;
  targetProgress = 0;
  visualProgressState.v = 0;
  ensureWindow(0); // re-center the resident window on Sleeping — frame 0 itself is already guaranteed resident
  lastWindowCenter = 0;
  applyFrame(0, textureCache.get(0));
  glow.alpha = 0;
  flash.alpha = 0;
  if (environment) environment.tint = 0xffffff;
  emberIntensityState.v = 1;
  if (sessionEl) sessionEl.classList.remove("dragon-fire-lit");
  layout(); // resets character/spriteWrapper position+scale to the correct contain-fit values
}

/**
 * MEMORY TRADEOFF (see final report): every resident/in-flight WAKE frame
 * EXCEPT frame 0 is released here, and the entire FAIL cache is dropped —
 * leaving Dragon for Rocket/Setup does not retain the windowed WAKE
 * neighborhood or the fully-preloaded FAIL range. Frame 0 alone stays
 * warm so a subsequent mount() (Play Again, or Dragon selected again
 * later) shows Sleeping instantly with zero network/decode wait, while
 * everything else is re-fetched on demand — the WAKE window as the meter
 * moves, the FAIL range once the tension zone is re-entered. Only the
 * PixiJS Application/canvas/display-object graph is torn down beyond
 * that.
 */
export function unmount(stageEl) {
  if (!mounted) return;
  mounted = false;

  for (const [, entry] of inFlight) { entry.wanted = false; }
  if (window.PIXI) {
    for (const idx of Array.from(textureCache.keys())) {
      if (idx !== 0) {
        textureCache.delete(idx);
        window.PIXI.Assets.unload(wakeFrameUrl(idx)).catch(() => {});
      }
    }
    if (failFramesLoaded || failPreloadPromise) {
      for (const idx of Array.from(failTextureCache.keys())) {
        window.PIXI.Assets.unload(failFrameUrl(idx)).catch(() => {});
      }
    }
  }
  failTextureCache = new Map();
  failFramesLoaded = false;
  failPreloadPromise = null;
  failPrefetchStarted = false;
  lastWindowCenter = -1;

  if (impactTimeline) { impactTimeline.kill(); impactTimeline = null; }
  if (idleTimeline) { idleTimeline.kill(); idleTimeline = null; }
  if (spriteWrapper) gsap.killTweensOf(spriteWrapper.scale);
  if (spriteWrapper) gsap.killTweensOf(spriteWrapper);
  if (character) gsap.killTweensOf(character);
  if (glow) gsap.killTweensOf(glow);
  if (environment) gsap.killTweensOf(environment);
  gsap.killTweensOf(emberIntensityState);
  emberIntensityState.v = 1;
  if (sessionEl) sessionEl.classList.remove("dragon-fire-lit");

  if (app) {
    if (resizeHandler) app.renderer.off("resize", resizeHandler);
    app.ticker.remove(tickProgress);
    if (app.canvas && stageEl.contains(app.canvas)) stageEl.removeChild(app.canvas);
    // texture:false — frame textures are intentionally retained (see the
    // memory-tradeoff note above), only the Pixi app/display objects go.
    app.destroy(true, { children: true, texture: false });
  }

  app = null;
  environment = null;
  character = null;
  spriteWrapper = null;
  dragonSprite = null;
  glow = null;
  emberLayer = null;
  flash = null;
  sessionEl = null;
  resizeHandler = null;
  failEventActive = false;
}
