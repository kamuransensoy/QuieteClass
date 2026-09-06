// Dragon Frame-Scrub POC — resolution + memory optimization pass.
// Standalone: no imports from, or dependencies on, production QuietClass.

const FRAME_COUNT = 167; // frame_0000.webp .. frame_0166.webp
const STUTTER_THRESHOLD_MS = 32; // ~2 frames at 60fps
const DEFAULT_WINDOW_SIZE = 15; // windowed cache: current ± N frames

const VARIANTS = {
  original: { dir: "frames-original", w: 1948, h: 1064, label: "Original" },
  "1280": { dir: "frames-1280", w: 1280, h: 699, label: "1280" },
  "960": { dir: "frames-960", w: 960, h: 524, label: "960" },
};

function frameUrl(dir, i) {
  return `${dir}/frame_${String(i).padStart(4, "0")}.webp`;
}
function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024).toFixed(1)} KB`;
}
function fmtMs(n) {
  return `${n.toFixed(1)} ms`;
}
function wakeToFrameIndex(wake) {
  const progress = wake / 99;
  return Math.round(progress * (FRAME_COUNT - 1));
}

// --- FrameStore: owns one resolution variant's frames, in either FULL or
// WINDOWED cache mode. FULL preloads and decodes every frame once, up
// front (identical to the original POC's behavior). WINDOWED keeps only
// [center-window, center+window] decoded via createImageBitmap(), evicts
// everything outside that range via ImageBitmap.close(), and coalesces
// superseded in-flight decodes when the requested center moves again
// before they resolve.
class FrameStore {
  constructor(key) {
    const v = VARIANTS[key];
    this.key = key;
    this.dir = v.dir;
    this.w = v.w;
    this.h = v.h;
    this.mode = "full";
    this.windowSize = DEFAULT_WINDOW_SIZE;
    this.fullImages = new Array(FRAME_COUNT).fill(null);
    this.fullLoaded = false;
    this.windowCache = new Map(); // index -> ImageBitmap
    this.inFlight = new Map(); // index -> Promise
    this.generation = 0;
    this.stats = { loadTimeMs: 0, totalBytes: 0 };
    this.coalescedCount = 0;
  }

  async loadFull() {
    if (this.fullLoaded) return this.stats;
    const t0 = performance.now();
    const CONCURRENCY = 8;
    let next = 0;
    let totalBytes = 0;
    const worker = async () => {
      while (next < FRAME_COUNT) {
        const i = next++;
        const res = await fetch(frameUrl(this.dir, i));
        const blob = await res.blob();
        totalBytes += blob.size;
        const img = new Image();
        img.src = URL.createObjectURL(blob);
        if (img.decode) await img.decode();
        else await new Promise((r) => { img.onload = r; });
        this.fullImages[i] = img;
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    this.stats.loadTimeMs = performance.now() - t0;
    this.stats.totalBytes = totalBytes;
    this.fullLoaded = true;
    return this.stats;
  }

  // Returns the image/bitmap for `index` if it is already resident
  // (synchronous, no decode). Returns null if not yet available.
  getIfResident(index) {
    if (this.mode === "full") return this.fullImages[index] || null;
    return this.windowCache.get(index) || null;
  }

  residentCount() {
    if (this.mode === "full") return this.fullImages.filter(Boolean).length;
    return this.windowCache.size;
  }

  async _decodeOne(index) {
    const res = await fetch(frameUrl(this.dir, index));
    const blob = await res.blob();
    return createImageBitmap(blob);
  }

  // Windowed mode only: ensures [center-window, center+window] is (or
  // will become) resident, evicting anything outside that range and
  // kicking off decodes for anything inside it that isn't cached yet.
  // Fire-and-forget — callers poll getIfResident() to notice completion.
  //
  // Precise per-frame cancellation: a small scrub (center moves by a
  // frame or two) mostly overlaps the previous window, so in-flight
  // decodes for frames that are STILL wanted are left alone rather than
  // being blanket-cancelled on every call — only decodes for frames that
  // fall genuinely outside the new window are marked unwanted and
  // discarded when they resolve. An earlier version bumped a single
  // "generation" counter on every call, which cancelled ALL in-flight
  // work on every request regardless of overlap — harmless on this local
  // dev server (decodes are fast enough to absorb the churn) but wasteful
  // decode work under continuous scrubbing, and worth avoiding on slower
  // hardware.
  ensureWindow(center) {
    if (this.mode !== "windowed") return;
    const lo = Math.max(0, center - this.windowSize);
    const hi = Math.min(FRAME_COUNT - 1, center + this.windowSize);
    const needed = new Set();
    for (let i = lo; i <= hi; i++) needed.add(i);

    for (const [idx, bmp] of this.windowCache) {
      if (!needed.has(idx)) {
        bmp.close();
        this.windowCache.delete(idx);
      }
    }
    for (const [idx, entry] of this.inFlight) {
      if (!needed.has(idx)) entry.wanted = false;
    }

    const order = [center, ...Array.from(needed).filter((i) => i !== center)]
      .sort((a, b) => Math.abs(a - center) - Math.abs(b - center));

    for (const idx of order) {
      if (this.windowCache.has(idx) || this.inFlight.has(idx)) continue;
      const entry = { wanted: true };
      entry.promise = this._decodeOne(idx)
        .then((bmp) => {
          this.inFlight.delete(idx);
          if (!entry.wanted) {
            bmp.close();
            this.coalescedCount++;
            return;
          }
          this.windowCache.set(idx, bmp);
        })
        .catch(() => { this.inFlight.delete(idx); });
      this.inFlight.set(idx, entry);
    }
  }

  switchToWindowed(windowSize) {
    this.mode = "windowed";
    this.windowSize = windowSize;
    this.windowCache.clear();
    this.inFlight.clear();
    this.coalescedCount = 0;
  }

  switchToFull() {
    this.mode = "full";
    for (const bmp of this.windowCache.values()) bmp.close();
    this.windowCache.clear();
    this.inFlight.clear();
  }
}

const stores = {
  original: new FrameStore("original"),
  "1280": new FrameStore("1280"),
  "960": new FrameStore("960"),
};

// --- DOM refs ---
const loadingEl = document.getElementById("loading");
const loadingBarEl = document.getElementById("loading-bar");
const loadingLabelEl = document.getElementById("loading-label");
const mainEl = document.getElementById("main");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const wakeSlider = document.getElementById("wake-slider");
const wakeReadoutEl = document.getElementById("wake-readout");
const frameReadoutEl = document.getElementById("frame-readout");
const presetBtns = Array.from(document.querySelectorAll(".preset-row .preset-btn"));
const variantBtns = Array.from(document.querySelectorAll("#variant-row .seg-btn"));
const variantStatusEl = document.getElementById("variant-status");
const cacheBtns = Array.from(document.querySelectorAll("#cache-row .seg-btn"));
const windowSizeLabelEl = document.getElementById("window-size-label");
const modeBtns = {
  forward: document.getElementById("btn-auto-forward"),
  reverse: document.getElementById("btn-auto-reverse"),
  pingPong: document.getElementById("btn-ping-pong"),
  stop: document.getElementById("btn-stop"),
};
const jumpBtns = Array.from(document.querySelectorAll(".jump-btn[data-from]"));
const runAllJumpsBtn = document.getElementById("btn-run-all-jumps");
const jumpResultsEl = document.getElementById("jump-results");
const runNoiseBtn = document.getElementById("btn-run-noise");
const noiseResultsEl = document.getElementById("noise-results");
const compareToggleBtn = document.getElementById("btn-toggle-compare");
const compareSection = document.getElementById("compare-section");
const canvas1280 = document.getElementById("canvas-1280");
const canvas960 = document.getElementById("canvas-960");
const comparePresetBtns = Array.from(document.querySelectorAll(".compare-preset-btn"));

const tm = {
  frameCount: document.getElementById("tm-frame-count"),
  dims: document.getElementById("tm-dims"),
  totalSize: document.getElementById("tm-total-size"),
  avgSize: document.getElementById("tm-avg-size"),
  loadTime: document.getElementById("tm-load-time"),
  decodedMem: document.getElementById("tm-decoded-mem"),
  heap: document.getElementById("tm-heap"),
  swapLatency: document.getElementById("tm-swap-latency"),
  swapAvg: document.getElementById("tm-swap-avg"),
  swapMax: document.getElementById("tm-swap-max"),
  stutterCount: document.getElementById("tm-stutter-count"),
  residentCount: document.getElementById("tm-resident-count"),
  decodeLatency: document.getElementById("tm-decode-latency"),
  staleDuration: document.getElementById("tm-stale-duration"),
  blankCount: document.getElementById("tm-blank-count"),
  coalescedCount: document.getElementById("tm-coalesced-count"),
};

// --- State ---
let activeVariantKey = "original";
let activeStore = stores.original;
let cacheMode = "full";
let currentWake = 0;
let currentFrameIndex = 0;
let paintedFrameIndex = -1; // what's actually on screen right now
let pending = null; // { index, requestTime } while waiting on a windowed decode
let autoRafId = null;
let autoMode = null;
let autoStartTime = 0;
let autoStartWake = 0;
let pingPongDirection = 1;
const AUTO_DURATION_MS = 5000;

const swapLatencies = [];
let swapMax = 0;
let stutterCount = 0;
let blankCount = 0;

// --- Canvas painting ---

function resizeCanvasTo(cnv, w, h) {
  const stage = cnv.parentElement;
  const rect = stage.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const aspect = w / h;
  let cw = rect.width;
  let ch = cw / aspect;
  if (ch > rect.height) { ch = rect.height; cw = ch * aspect; }
  cnv.style.width = `${cw}px`;
  cnv.style.height = `${ch}px`;
  cnv.width = Math.round(cw * dpr);
  cnv.height = Math.round(ch * dpr);
}

function resizeCanvas() {
  resizeCanvasTo(canvas, activeStore.w, activeStore.h);
  paintCurrent();
}

function paint(cnv, cctx, img) {
  cctx.clearRect(0, 0, cnv.width, cnv.height);
  cctx.drawImage(img, 0, 0, cnv.width, cnv.height);
}

function paintCurrent() {
  const img = activeStore.getIfResident(paintedFrameIndex >= 0 ? paintedFrameIndex : currentFrameIndex);
  if (img) paint(canvas, ctx, img);
}

// --- Core request/display logic (shared by manual + programmatic drivers) ---

function requestDisplay(wake, opts = {}) {
  const clamped = Math.max(0, Math.min(99, Math.round(wake)));
  currentWake = clamped;
  currentFrameIndex = wakeToFrameIndex(clamped);
  wakeReadoutEl.textContent = `${clamped}%`;
  frameReadoutEl.textContent = `${currentFrameIndex} / ${FRAME_COUNT - 1}`;
  wakeSlider.value = String(clamped);

  const t0 = performance.now();
  const img = activeStore.getIfResident(currentFrameIndex);

  if (img) {
    pending = null;
    requestAnimationFrame(() => {
      paint(canvas, ctx, img);
      const latency = performance.now() - t0;
      paintedFrameIndex = currentFrameIndex;
      recordSwap(latency);
      tm.decodeLatency.textContent = "0.0 ms (resident)";
      tm.staleDuration.textContent = "0.0 ms";
    });
  } else {
    // Not resident (windowed mode, out of window). Keep the previous
    // frame visible (stale) and kick off a decode; a background ticker
    // will paint it once ready and record how long it stayed stale.
    if (paintedFrameIndex === -1) blankCount++; // nothing has ever been painted yet
    pending = { index: currentFrameIndex, requestTime: t0 };
    if (activeStore.mode === "windowed") activeStore.ensureWindow(currentFrameIndex);
  }
  updateHeapTelemetry();
}

// Background ticker: resolves `pending` as soon as the requested frame
// becomes resident, independent of whatever triggered the request
// (manual slider, auto-play, or a programmatic test).
function tickPendingResolver() {
  if (pending) {
    const img = activeStore.getIfResident(pending.index);
    if (img) {
      const now = performance.now();
      const decodeLatency = now - pending.requestTime;
      paint(canvas, ctx, img);
      paintedFrameIndex = pending.index;
      recordSwap(decodeLatency);
      tm.decodeLatency.textContent = fmtMs(decodeLatency);
      tm.staleDuration.textContent = fmtMs(decodeLatency); // stale from request until this paint
      pending = null;
    }
  }
  tm.residentCount.textContent = String(activeStore.residentCount());
  tm.coalescedCount.textContent = String(activeStore.coalescedCount);
  tm.blankCount.textContent = String(blankCount);
  requestAnimationFrame(tickPendingResolver);
}
requestAnimationFrame(tickPendingResolver);

function recordSwap(latency) {
  swapLatencies.push(latency);
  if (swapLatencies.length > 60) swapLatencies.shift();
  if (latency > swapMax) swapMax = latency;
  if (latency > STUTTER_THRESHOLD_MS) stutterCount++;
  tm.swapLatency.textContent = fmtMs(latency);
  const avg = swapLatencies.reduce((a, b) => a + b, 0) / swapLatencies.length;
  tm.swapAvg.textContent = fmtMs(avg);
  tm.swapMax.textContent = fmtMs(swapMax);
  tm.stutterCount.textContent = String(stutterCount);
}

function updateHeapTelemetry() {
  if (performance.memory) {
    tm.heap.textContent = `${(performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(1)} MB (JS heap only — does not include decoded image memory)`;
  } else {
    tm.heap.textContent = "not available in this browser";
  }
}

function updateVariantTelemetry() {
  const v = VARIANTS[activeVariantKey];
  const s = activeStore.stats;
  tm.frameCount.textContent = String(FRAME_COUNT);
  tm.dims.textContent = `${v.w}×${v.h}`;
  tm.totalSize.textContent = s.totalBytes ? fmtBytes(s.totalBytes) : "– (windowed: loaded on demand)";
  tm.avgSize.textContent = s.totalBytes ? fmtBytes(s.totalBytes / FRAME_COUNT) : "–";
  tm.loadTime.textContent = s.loadTimeMs ? fmtMs(s.loadTimeMs) : "–";
  const decodedBytes = v.w * v.h * 4 * FRAME_COUNT;
  tm.decodedMem.textContent = `${(decodedBytes / 1024 / 1024).toFixed(0)} MB (theoretical: W×H×4×frames)`;
}

// --- Variant switching ---

async function activateVariant(key) {
  activeVariantKey = key;
  activeStore = stores[key];
  variantBtns.forEach((b) => b.classList.toggle("active", b.dataset.variant === key));

  if (cacheMode === "full" && !activeStore.fullLoaded) {
    variantStatusEl.textContent = `Loading ${VARIANTS[key].label}…`;
    await activeStore.loadFull();
  }
  if (activeStore.mode !== cacheMode) {
    if (cacheMode === "windowed") activeStore.switchToWindowed(DEFAULT_WINDOW_SIZE);
    else activeStore.switchToFull();
  }
  variantStatusEl.textContent = `${VARIANTS[key].label} ready (${activeStore.mode.toUpperCase()} cache).`;
  paintedFrameIndex = -1;
  resizeCanvas();
  updateVariantTelemetry();
  requestDisplay(currentWake);
}

async function setCacheMode(mode) {
  cacheMode = mode;
  cacheBtns.forEach((b) => b.classList.toggle("active", b.dataset.cache === mode));
  if (mode === "full") {
    if (!activeStore.fullLoaded) {
      variantStatusEl.textContent = `Loading ${VARIANTS[activeVariantKey].label} (full)…`;
      await activeStore.loadFull();
    }
    activeStore.switchToFull();
  } else {
    activeStore.switchToWindowed(DEFAULT_WINDOW_SIZE);
  }
  variantStatusEl.textContent = `${VARIANTS[activeVariantKey].label} ready (${activeStore.mode.toUpperCase()} cache).`;
  paintedFrameIndex = -1;
  updateVariantTelemetry();
  requestDisplay(currentWake);
}

// --- Wiring: primary controls ---

wakeSlider.addEventListener("input", () => { stopAuto(); requestDisplay(Number(wakeSlider.value)); });
presetBtns.forEach((btn) => btn.addEventListener("click", () => { stopAuto(); requestDisplay(Number(btn.dataset.wake)); }));
variantBtns.forEach((btn) => btn.addEventListener("click", () => activateVariant(btn.dataset.variant)));
cacheBtns.forEach((btn) => btn.addEventListener("click", () => setCacheMode(btn.dataset.cache)));
window.addEventListener("resize", resizeCanvas);
windowSizeLabelEl.textContent = String(DEFAULT_WINDOW_SIZE);

// --- Auto-play modes ---

function stopAuto() {
  if (autoRafId !== null) { cancelAnimationFrame(autoRafId); autoRafId = null; }
  autoMode = null;
  Object.values(modeBtns).forEach((b) => b.classList.remove("active"));
}

function tickAuto(now) {
  if (!autoMode) return;
  const elapsed = now - autoStartTime;
  const t = Math.min(1, elapsed / AUTO_DURATION_MS);
  if (autoMode === "forward") {
    requestDisplay(autoStartWake + t * (99 - autoStartWake));
    if (t >= 1) { stopAuto(); return; }
  } else if (autoMode === "reverse") {
    requestDisplay(autoStartWake - t * autoStartWake);
    if (t >= 1) { stopAuto(); return; }
  } else if (autoMode === "pingPong") {
    const from = pingPongDirection > 0 ? 0 : 99;
    const to = pingPongDirection > 0 ? 99 : 0;
    requestDisplay(from + t * (to - from));
    if (t >= 1) { pingPongDirection *= -1; autoStartTime = now; }
  }
  autoRafId = requestAnimationFrame(tickAuto);
}

function startAuto(mode) {
  stopAuto();
  autoMode = mode;
  autoStartWake = currentWake;
  autoStartTime = performance.now();
  if (mode === "pingPong") pingPongDirection = currentWake < 99 ? 1 : -1;
  modeBtns[mode].classList.add("active");
  autoRafId = requestAnimationFrame(tickAuto);
}

modeBtns.forward.addEventListener("click", () => startAuto("forward"));
modeBtns.reverse.addEventListener("click", () => startAuto("reverse"));
modeBtns.pingPong.addEventListener("click", () => startAuto("pingPong"));
modeBtns.stop.addEventListener("click", stopAuto);

// --- Rapid jump test ---

function waitFrames(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForSettled(wake, timeoutMs = 4000) {
  requestDisplay(wake);
  const t0 = performance.now();
  while (pending && performance.now() - t0 < timeoutMs) await waitFrames(16);
}

async function runJump(from, to) {
  await waitForSettled(from);
  await waitFrames(150); // let the "from" state fully settle / window re-center
  const blankBefore = blankCount;
  const t0 = performance.now();
  requestDisplay(to);
  const timeout = performance.now() + 4000;
  while (pending && performance.now() < timeout) await waitFrames(4);
  const elapsed = performance.now() - t0;
  const timedOut = !!pending;
  return {
    from, to,
    timeToVisibleMs: timedOut ? null : elapsed,
    timedOut,
    blankFrameOccurred: blankCount > blankBefore,
    residentAfter: activeStore.residentCount(),
  };
}

async function runAllJumps() {
  const jumps = [[0, 99], [99, 0], [10, 90], [90, 25], [25, 75]];
  jumpResultsEl.textContent = `Running on ${VARIANTS[activeVariantKey].label} / ${cacheMode.toUpperCase()} cache…\n`;
  const lines = [];
  for (const [from, to] of jumps) {
    const r = await runJump(from, to);
    const line = `${r.from}→${r.to}: ${r.timedOut ? "TIMED OUT" : fmtMs(r.timeToVisibleMs)}${r.blankFrameOccurred ? " [BLANK]" : ""} (resident=${r.residentAfter})`;
    lines.push(line);
    jumpResultsEl.textContent = `${VARIANTS[activeVariantKey].label} / ${cacheMode.toUpperCase()} cache\n` + lines.join("\n");
  }
}

jumpBtns.forEach((btn) => {
  btn.addEventListener("click", async () => {
    stopAuto();
    const r = await runJump(Number(btn.dataset.from), Number(btn.dataset.to));
    jumpResultsEl.textContent = `${VARIANTS[activeVariantKey].label} / ${cacheMode.toUpperCase()} cache\n${r.from}→${r.to}: ${r.timedOut ? "TIMED OUT" : fmtMs(r.timeToVisibleMs)}${r.blankFrameOccurred ? " [BLANK]" : ""} (resident=${r.residentAfter})`;
  });
});
runAllJumpsBtn.addEventListener("click", () => { stopAuto(); runAllJumps(); });

// --- Realistic noisy Wake Meter sequence, smoothed target-chasing ---

const NOISE_SEQUENCE = [10, 13, 18, 24, 31, 38, 45, 52, 48, 55, 63, 71, 68, 76, 84, 91, 87, 72, 58, 43, 28, 15];
const NOISE_STEP_MS = 130; // approximate arrival rate of one new "mic-driven" target
const SMOOTHING = 0.22; // visualWake += (target - visualWake) * SMOOTHING, per rAF tick

async function runNoiseSequenceOnce(label) {
  let visualWake = currentWake;
  let target = visualWake;
  let idx = 0;
  const localStutter = { count: 0, max: 0 };
  const blankBefore = blankCount;
  const coalescedBefore = activeStore.coalescedCount;
  let running = true;

  const stepTimer = setInterval(() => {
    if (idx < NOISE_SEQUENCE.length) { target = NOISE_SEQUENCE[idx++]; }
    else { clearInterval(stepTimer); }
  }, NOISE_STEP_MS);

  function tick() {
    visualWake += (target - visualWake) * SMOOTHING;
    const t0 = performance.now();
    requestDisplay(visualWake);
    requestAnimationFrame(() => {
      const latency = performance.now() - t0;
      if (latency > STUTTER_THRESHOLD_MS) { localStutter.count++; }
      if (latency > localStutter.max) localStutter.max = latency;
    });
    if (idx < NOISE_SEQUENCE.length || Math.abs(target - visualWake) > 0.5) {
      requestAnimationFrame(tick);
    } else {
      running = false;
    }
  }
  requestAnimationFrame(tick);

  const hardTimeout = performance.now() + NOISE_STEP_MS * NOISE_SEQUENCE.length + 3000;
  while (running && performance.now() < hardTimeout) await waitFrames(30);

  return {
    label,
    stutterCount: localStutter.count,
    maxLatencyMs: localStutter.max,
    blankFrames: blankCount - blankBefore,
    coalesced: activeStore.coalescedCount - coalescedBefore,
    finalWake: Math.round(visualWake),
  };
}

runNoiseBtn.addEventListener("click", async () => {
  stopAuto();
  noiseResultsEl.textContent = `Running on ${VARIANTS[activeVariantKey].label}…\n`;
  const prevMode = cacheMode;

  await setCacheMode("full");
  const fullResult = await runNoiseSequenceOnce("FULL CACHE");
  noiseResultsEl.textContent += `FULL CACHE: stutters=${fullResult.stutterCount} maxLatency=${fmtMs(fullResult.maxLatencyMs)} blank=${fullResult.blankFrames} finalWake=${fullResult.finalWake}%\n`;

  await setCacheMode("windowed");
  const windowedResult = await runNoiseSequenceOnce("WINDOWED CACHE");
  noiseResultsEl.textContent += `WINDOWED CACHE: stutters=${windowedResult.stutterCount} maxLatency=${fmtMs(windowedResult.maxLatencyMs)} blank=${windowedResult.blankFrames} coalesced=${windowedResult.coalesced} finalWake=${windowedResult.finalWake}%\n`;

  await setCacheMode(prevMode);
});

// --- Side-by-side comparison (1280 vs 960, always full-cache, visual-only) ---

let compareLoaded = false;

compareToggleBtn.addEventListener("click", async () => {
  const showing = !compareSection.hidden;
  if (showing) {
    compareSection.hidden = true;
    compareToggleBtn.textContent = "Show 1280 vs 960 comparison";
    return;
  }
  compareSection.hidden = false;
  compareToggleBtn.textContent = "Hide 1280 vs 960 comparison";
  if (!compareLoaded) {
    compareToggleBtn.disabled = true;
    await Promise.all([stores["1280"].loadFull(), stores["960"].loadFull()]);
    compareLoaded = true;
    compareToggleBtn.disabled = false;
  }
  // Compare is always full-cache/visual-only — force this explicitly,
  // since either store may currently be in windowed mode left over from
  // the main view's cache-mode testing (getIfResident() in windowed mode
  // only returns frames inside whatever the *other* view last scrubbed
  // to, which would silently show a stale frame here otherwise).
  stores["1280"].switchToFull();
  stores["960"].switchToFull();
  resizeCanvasTo(canvas1280, VARIANTS["1280"].w, VARIANTS["1280"].h);
  resizeCanvasTo(canvas960, VARIANTS["960"].w, VARIANTS["960"].h);
  paintCompare(currentWake);
});

function paintCompare(wake) {
  if (!compareLoaded) return;
  const idx = wakeToFrameIndex(Math.max(0, Math.min(99, Math.round(wake))));
  const img1280 = stores["1280"].getIfResident(idx);
  const img960 = stores["960"].getIfResident(idx);
  if (img1280) paint(canvas1280, canvas1280.getContext("2d"), img1280);
  if (img960) paint(canvas960, canvas960.getContext("2d"), img960);
}

comparePresetBtns.forEach((btn) => {
  btn.addEventListener("click", () => paintCompare(Number(btn.dataset.wake)));
});
window.addEventListener("resize", () => { if (!compareSection.hidden) paintCompare(currentWake); });

// --- Initial load: Original variant, full cache (matches the prior POC's baseline) ---

(async function init() {
  loadingLabelEl.textContent = "Loading Original frames…";
  await activeStore.loadFull();
  loadingEl.hidden = true;
  mainEl.hidden = false;
  variantStatusEl.textContent = `${VARIANTS[activeVariantKey].label} ready (${activeStore.mode.toUpperCase()} cache).`;
  updateVariantTelemetry();
  resizeCanvas();
  requestDisplay(0);
})().catch((err) => {
  loadingLabelEl.textContent = `Load failed: ${err.message}`;
  console.error(err);
});
