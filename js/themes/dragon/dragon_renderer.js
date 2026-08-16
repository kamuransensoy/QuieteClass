// dragon/renderer.js
// Video-based Dragon renderer. Two <video> layers are mounted once and
// reused for every state change via opacity crossfade — no SVG, no RAF
// loop, no per-frame JS/DOM writes. Browser-native video decoding does
// all the animation work.

const IDLE_VIDEOS = {
  CALM: "assets/video/dragon/idle/dragon_calm_idle.mp4",
  LOW: "assets/video/dragon/idle/dragon_low_idle.mp4",
  MEDIUM: "assets/video/dragon/idle/dragon_medium_idle.mp4",
  HIGH: "assets/video/dragon/idle/dragon_high_idle.mp4",
};
const CRITICAL_VIDEO = "assets/video/dragon/events/dragon_critical_fire.mp4";
// Sequential fade avoids "double dragon" ghosting: outgoing fades out
// first, then (only once gone) incoming fades in, revealing a brief
// dark beat rather than a hard cut or simultaneous overlap.
const FADE_OUT_MS = 350;
const FADE_IN_MS = 350; // total ~700ms, within the 600-800ms target

// Dragon's own visual-bucket mapping: how THIS theme turns the shared
// Wake Meter (0-100) into one of its four idle videos. Other themes may
// interpret the same number completely differently — core only ever
// hands over the raw wakeMeter (see updateProgress below). Upward
// thresholds are immediate; downward ones require a meaningful drop
// (hysteresis) so the video doesn't flicker near a boundary.
const BUCKET_THRESHOLDS = {
  CALM_TO_LOW: 20,
  LOW_TO_CALM: 15,
  LOW_TO_MEDIUM: 45,
  MEDIUM_TO_LOW: 38,
  MEDIUM_TO_HIGH: 70,
  HIGH_TO_MEDIUM: 62,
};

function stepBucket(previous, meter) {
  const t = BUCKET_THRESHOLDS;
  switch (previous) {
    case "CALM": return meter >= t.CALM_TO_LOW ? "LOW" : "CALM";
    case "LOW":
      if (meter >= t.LOW_TO_MEDIUM) return "MEDIUM";
      return meter < t.LOW_TO_CALM ? "CALM" : "LOW";
    case "MEDIUM":
      if (meter >= t.MEDIUM_TO_HIGH) return "HIGH";
      return meter < t.MEDIUM_TO_LOW ? "LOW" : "MEDIUM";
    case "HIGH": return meter < t.HIGH_TO_MEDIUM ? "MEDIUM" : "HIGH";
    default: return "CALM";
  }
}

// Bounded loop: a single large jump (e.g. after a clamped large dt)
// still lands on the correct bucket in one call.
function deriveBucket(previous, meter) {
  let bucket = previous;
  for (let i = 0; i < 4; i++) {
    const next = stepBucket(bucket, meter);
    if (next === bucket) break;
    bucket = next;
  }
  return bucket;
}

let container = null;
let layers = [null, null];  // two <video> elements, reused for every transition
let activeIndex = 0;        // which layer is currently visible
let mounted = false;
let currentVisualKey = null; // bucket name currently shown, or "FAIL_EVENT"
let pendingBucket = "CALM";  // latest requested idle bucket
let failEventActive = false;
let failEventListener = null; // { layer, handler } while a fail event is armed
let fadeCleanupTimer = null;
let currentBucket = "CALM"; // this theme's own derived visual bucket, tracked across updateProgress calls

export function mount(stageEl) {
  container = document.createElement("div");
  container.style.cssText = "position:absolute;inset:0;background:var(--color-bg,#0f1420);overflow:hidden;";

  layers = [createLayer(), createLayer()];
  container.append(layers[0], layers[1]);
  stageEl.appendChild(container);

  mounted = true;
  activeIndex = 0;
  currentVisualKey = null;
  pendingBucket = "CALM";
  failEventActive = false;
  failEventListener = null;
  currentBucket = "CALM";

  // First frame: show CALM directly on layer 0, no crossfade needed.
  const first = layers[0];
  first.loop = true;
  first.src = IDLE_VIDEOS.CALM;
  first.style.opacity = "1";
  layers[1].style.opacity = "0";
  safePlay(first);
  currentVisualKey = "CALM";
}

function createLayer() {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  // transition-duration/-delay are set per-transition in switchTo(), not
  // here, so the very first mount (instant, no fade) never animates.
  video.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:contain;
    opacity:0;transition-property:opacity;background:var(--color-bg,#0f1420);`;
  video.addEventListener("error", () => {
    console.error("QuietClass: dragon video failed to load:", video.currentSrc || video.src);
  });
  return video;
}

function safePlay(video) {
  const playResult = video.play();
  if (playResult && typeof playResult.catch === "function") {
    playResult.catch((err) => console.error("QuietClass: dragon video play() failed:", err));
  }
}

// Loads `src` into the currently-hidden layer, waits until it can play,
// then runs a sequential fade: the outgoing layer fades out first, then
// the incoming layer fades in (see FADE_OUT_MS/FADE_IN_MS above) —
// avoiding a simultaneous-overlap "double dragon" ghost.
function switchTo(src, loop, onVisible) {
  const targetIndex = 1 - activeIndex;
  const layer = layers[targetIndex];
  const outgoing = layers[activeIndex];

  const reveal = () => {
    layer.removeEventListener("canplay", reveal);
    safePlay(layer);

    outgoing.style.transitionDuration = `${FADE_OUT_MS}ms`;
    outgoing.style.transitionDelay = "0ms";
    layer.style.transitionDuration = `${FADE_IN_MS}ms`;
    layer.style.transitionDelay = `${FADE_OUT_MS}ms`;

    outgoing.style.opacity = "0";
    layer.style.opacity = "1";
    activeIndex = targetIndex;
    if (onVisible) onVisible();

    clearTimeout(fadeCleanupTimer);
    fadeCleanupTimer = setTimeout(() => {
      if (outgoing !== layers[activeIndex]) outgoing.pause();
    }, FADE_OUT_MS + 50); // outgoing is already invisible by then; no need to wait for the incoming fade too
  };

  layer.loop = loop;
  layer.src = src;
  layer.currentTime = 0;
  layer.load();
  if (layer.readyState >= 3) {
    reveal();
  } else {
    layer.addEventListener("canplay", reveal, { once: true });
  }
}

function showIdle(bucket) {
  if (currentVisualKey === bucket) return; // duplicate request for the bucket already shown
  switchTo(IDLE_VIDEOS[bucket], true, () => { currentVisualKey = bucket; });
}

function clearFailEventListener() {
  if (failEventListener) {
    failEventListener.layer.removeEventListener("ended", failEventListener.handler);
    failEventListener = null;
  }
}
// The ONLY progress signal this theme receives from core: the shared
// Wake Meter (0-100). Dragon maps it to a discrete video bucket with
// hysteresis (see deriveBucket above) — a different theme is free to
// use the same raw number completely differently.
export function updateProgress(wakeMeter) {
  currentBucket = deriveBucket(currentBucket, wakeMeter);
  pendingBucket = currentBucket;
  if (failEventActive) return; // store only — never interrupt the fail event
  showIdle(currentBucket);
}

export function triggerFailEvent(onComplete) {
  if (!mounted || failEventActive) return; // fires once; ignore re-entry while already playing
  failEventActive = true;

  const targetIndex = 1 - activeIndex;
  const handler = () => {
    failEventListener = null;
    failEventActive = false;
    currentVisualKey = null; // force the next idle switch even if it matches pendingBucket
    showIdle(pendingBucket);
    if (onComplete) onComplete();
  };
  layers[targetIndex].addEventListener("ended", handler, { once: true });
  failEventListener = { layer: layers[targetIndex], handler };

  switchTo(CRITICAL_VIDEO, false, () => { currentVisualKey = "FAIL_EVENT"; });
}

export function resolveFailEvent() {
  // Intentional no-op: the fail event must finish on its own "ended"
  // event (see triggerFailEvent). session.js remains the source of
  // truth for when a new fail event is allowed to fire again.
}

export function onSessionEnd() {
  if (!mounted) return;
  clearFailEventListener();
  layers.forEach((layer) => layer.pause());
  currentVisualKey = null;
  pendingBucket = "CALM";
  failEventActive = false;
  currentBucket = "CALM";
}

export function unmount(stageEl) {
  if (!mounted) return;
  clearTimeout(fadeCleanupTimer);
  clearFailEventListener();
  layers.forEach((layer) => {
    layer.pause();
    layer.removeAttribute("src");
    layer.load();
  });
  if (container && stageEl.contains(container)) stageEl.removeChild(container);

  container = null;
  layers = [null, null];
  mounted = false;
  activeIndex = 0;
  currentVisualKey = null;
  pendingBucket = "CALM";
  failEventActive = false;
  currentBucket = "CALM";
}
