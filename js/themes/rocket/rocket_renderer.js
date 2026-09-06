// rocket/renderer.js
// PixiJS rocket mission renderer — ported from the approved POC at
// experiments/rocket-pixi-poc/. Implements the same theme contract the
// previous SVG renderer did (see themeRegistry.js); core (app.js/session.js)
// still owns mission start/end, timer, pause, noise->wakeMeter, and calls
// this module purely for visualization. This module never touches HUD DOM
// — the existing HTML HUD (meter, timer, Pause/End) remains authoritative.
//
// PixiJS itself is not bundled directly into this file — it's loaded via
// the shared js/core/pixiLoader.js (vendored locally as
// js/vendor/pixi.min.js, no CDN/network dependency), the same loader
// Dragon uses. Whichever theme mounts first pays the one-time load cost;
// window.PIXI is cached and reused either way, so there is still only
// ever one PixiJS on the page.

import { ensurePixiLoaded } from "../../core/pixiLoader.js";

const ASSET_PATH = "assets/rocket/rocket.png";
const NOZZLE_POINTS_REAL = [
  { x: 0.5025, y: 0.9965, scale: 1 },
  { x: 0.2284, y: 0.9965, scale: 0.62 },
  { x: 0.7394, y: 0.9965, scale: 0.62 },
];
const NOZZLE_POINTS_PLACEHOLDER = [
  { x: 0.5, y: 0.955, scale: 1 },
  { x: 0.30, y: 0.92, scale: 0.62 },
  { x: 0.70, y: 0.92, scale: 0.62 },
];

const LAUNCH_HOLD = 0.45;
const LAUNCH_RISE = 2.6;
const LAUNCH_TOTAL = LAUNCH_HOLD + LAUNCH_RISE;

const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// Nonlinear ignition curve: near-zero through 70-85% ("relatively narrow
// exhaust"), then rockets up 85-99% ("dramatically different"), instead of
// a plain smoothstep that would already be near-max by 85%. Boosters start
// a little later than the main engine, matching the 70-85% spec.
const MAIN_IGNITE_START = 0.70;
const BOOST_IGNITE_START = 0.76;
const IGNITE_END = 0.99;
const IGNITE_POWER = 2.4;
function ignitionCurve(e, start) {
  if (e <= start) return 0;
  if (e >= IGNITE_END) return 1;
  const t = (e - start) / (IGNITE_END - start);
  return Math.pow(t, IGNITE_POWER);
}

let mounted = false;
let app = null;
let scene = null; // built by buildScene(), see below
let resizeHandler = null;

let targetEnergy = 0; // set by updateProgress(), 0-1
let energy = 0;       // smoothed toward targetEnergy every tick
let launching = false;
let launchT = 0;
let launchOnComplete = null;
let phase = 0;

// --- Contract -----------------------------------------------------------

export async function mount(stageEl) {
  mounted = true;
  targetEnergy = 0; energy = 0; launching = false; launchT = 0; launchOnComplete = null; phase = 0;

  try {
    await ensurePixiLoaded();
  } catch (err) {
    console.error(err);
    mounted = false;
    return;
  }
  if (!mounted) return; // unmounted while the script was loading

  const PIXI = window.PIXI;
  app = new PIXI.Application();
  await app.init({
    resizeTo: stageEl,
    background: 0x04060c,
    antialias: true,
    resolution: Math.min(devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  if (!mounted) { // unmounted while init() was in flight
    app.destroy(true, { children: true, texture: true });
    app = null;
    return;
  }

  app.canvas.style.display = "block";
  app.canvas.style.width = "100%";
  app.canvas.style.height = "100%";
  stageEl.appendChild(app.canvas);

  scene = await buildScene(PIXI, app);
  if (!mounted) { // unmounted while assets were loading
    teardown(stageEl);
    return;
  }

  resizeHandler = () => layout(PIXI, app, scene);
  app.renderer.on("resize", resizeHandler);
  layout(PIXI, app, scene);

  app.ticker.add(tick);
}

export function updateProgress(wakeMeter) {
  targetEnergy = Math.max(0, Math.min(1, wakeMeter / 100));
}

export function triggerFailEvent(onComplete) {
  if (!mounted || launching) return; // fires once; ignore re-entry while already playing
  launching = true;
  launchT = 0;
  launchOnComplete = onComplete || null;
  if (scene) scene.world.position.set(0, 0);
}

export function resolveFailEvent() {
  // Intentional no-op: the launch sequence always finishes on its own
  // fixed timeline (LAUNCH_TOTAL) — nothing external can resolve it early.
}

export function onSessionEnd() {
  if (!mounted) return;
  launching = false;
  launchOnComplete = null;
  targetEnergy = 0;
  energy = 0;
  resetVisual();
}

export function unmount(stageEl) {
  if (!mounted) return;
  mounted = false;
  teardown(stageEl);
}

function teardown(stageEl) {
  if (app) {
    if (resizeHandler) app.renderer.off("resize", resizeHandler);
    app.ticker.stop();
    if (app.canvas && stageEl && stageEl.contains(app.canvas)) stageEl.removeChild(app.canvas);
    app.destroy(true, { children: true, texture: true });
  }
  app = null;
  scene = null;
  resizeHandler = null;
  launching = false;
  launchOnComplete = null;
}

function resetVisual() {
  if (!scene) return;
  scene.rocketGroup.position.set(scene.rocketGroup.baseX ?? 0, scene.rocketGroup.baseY ?? 0);
  scene.rocketGroup.alpha = 1;
  scene.world.position.set(0, 0);
  scene.plumes.forEach((pl) => { pl.container.visible = false; });
}

// --- scene construction (ported from experiments/rocket-pixi-poc/main.js) --

async function buildScene(PIXI, app) {
  function softTexture(size, stops) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d");
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    stops.forEach(([offset, color]) => g.addColorStop(offset, color));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return PIXI.Texture.from(c);
  }

  // Tapered, soft-edged directional plume shape (narrow+bright at the
  // nozzle, widening downward, fading toward the tail) — see the POC for
  // the full rationale. `stops` are {t, widthFrac, alpha} from nozzle
  // (t=0) to tail (t=1).
  function coneTexture(w, h, color, stops) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    const STEPS = 48;
    for (let i = 0; i < STEPS; i++) {
      const t = i / (STEPS - 1);
      let a = stops[0], b = stops[stops.length - 1];
      for (let k = 0; k < stops.length - 1; k++) {
        if (t >= stops[k].t && t <= stops[k + 1].t) { a = stops[k]; b = stops[k + 1]; break; }
      }
      const lt = Math.min(1, Math.max(0, (t - a.t) / Math.max(1e-6, b.t - a.t)));
      const widthFrac = a.widthFrac + (b.widthFrac - a.widthFrac) * lt;
      const alpha = a.alpha + (b.alpha - a.alpha) * lt;
      const y = t * h, sliceH = h / STEPS + 1.5, cx = w / 2;
      const halfW = Math.max(0.6, (widthFrac * w) / 2);
      const g = ctx.createLinearGradient(cx - halfW, 0, cx + halfW, 0);
      g.addColorStop(0, `rgba(${color},0)`);
      g.addColorStop(0.5, `rgba(${color},${alpha})`);
      g.addColorStop(1, `rgba(${color},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(cx - halfW, y, halfW * 2, sliceH);
    }
    return PIXI.Texture.from(c);
  }

  const TEX = {
    soft: softTexture(128, [[0, "rgba(255,255,255,1)"], [0.5, "rgba(255,255,255,0.4)"], [1, "rgba(255,255,255,0)"]]),
    // Sharper narrow-to-wide taper than before (was a gentle ~2x spread;
    // now ~3x) so each layer individually reads as "narrow at nozzle,
    // widening downward" instead of additive-stacking into a flat column.
    core: coneTexture(48, 128, "255,250,235", [
      { t: 0, widthFrac: 0.30, alpha: 1.0 }, { t: 0.2, widthFrac: 0.24, alpha: 0.9 },
      { t: 0.55, widthFrac: 0.16, alpha: 0.35 }, { t: 1, widthFrac: 0.08, alpha: 0 },
    ]),
    inner: coneTexture(64, 144, "255,210,61", [
      { t: 0, widthFrac: 0.42, alpha: 0.9 }, { t: 0.3, widthFrac: 0.40, alpha: 0.75 },
      { t: 0.65, widthFrac: 0.30, alpha: 0.3 }, { t: 1, widthFrac: 0.18, alpha: 0 },
    ]),
    outer: coneTexture(80, 160, "255,122,61", [
      { t: 0, widthFrac: 0.30, alpha: 0.85 }, { t: 0.3, widthFrac: 0.55, alpha: 0.62 },
      { t: 0.65, widthFrac: 0.85, alpha: 0.3 }, { t: 1, widthFrac: 1.0, alpha: 0 },
    ]),
    plumeGlow: coneTexture(96, 176, "255,157,63", [
      { t: 0, widthFrac: 0.45, alpha: 0.18 }, { t: 0.4, widthFrac: 0.85, alpha: 0.13 },
      { t: 0.8, widthFrac: 0.95, alpha: 0.05 }, { t: 1, widthFrac: 0.8, alpha: 0 },
    ]),
    glow: softTexture(160, [[0, "rgba(255,179,71,0.4)"], [0.6, "rgba(255,157,63,0.16)"], [1, "rgba(255,157,63,0)"]]),
    warmSpot: softTexture(64, [[0, "rgba(255,178,80,1)"], [0.4, "rgba(255,178,80,0.5)"], [1, "rgba(255,178,80,0)"]]),
  };

  function softSprite(tex, tint = 0xffffff, blend = "normal") {
    const s = new PIXI.Sprite(tex);
    s.anchor.set(0.5);
    s.tint = tint;
    s.blendMode = blend;
    return s;
  }

  const world = new PIXI.Container();
  app.stage.addChild(world);

  const sky = new PIXI.Graphics();
  const atmo = softSprite(TEX.glow, 0x5a4dff, "add");
  atmo.alpha = 0.5;
  const horizonGlow = softSprite(TEX.glow, 0x3d5a80, "add");
  horizonGlow.alpha = 0.5;
  const horizon = new PIXI.Graphics();
  world.addChild(sky, atmo, horizonGlow, horizon);

  let starsSprite = null;
  function buildStars(w, h) {
    if (starsSprite) { world.removeChild(starsSprite); starsSprite.destroy(); }
    const g = new PIXI.Graphics();
    for (let i = 0; i < 220; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h * 0.62;
      const r = 0.5 + Math.random() * 1.1;
      g.circle(x, y, r).fill({ color: 0xdfe6f5, alpha: 0.4 + Math.random() * 0.5 });
    }
    const tex = app.renderer.generateTexture(g);
    g.destroy();
    starsSprite = new PIXI.Sprite(tex);
    world.addChild(starsSprite);
    world.setChildIndex(starsSprite, 4);
  }

  const platform = new PIXI.Graphics();
  const gantry = new PIXI.Container();
  const gantryGfx = new PIXI.Graphics();
  gantry.addChild(gantryGfx);
  const beacon = softSprite(TEX.warmSpot, 0xff6b6b, "add");
  const gantryLight = softSprite(TEX.warmSpot, 0xffb347, "add");
  gantry.addChild(beacon, gantryLight);
  const practicalLights = [];
  for (let i = 0; i < 6; i++) {
    const l = softSprite(TEX.warmSpot, 0xffb347, "add");
    l.scale.set(0.5);
    practicalLights.push(l);
  }
  world.addChild(platform, gantry, ...practicalLights);

  const contactShadow = softSprite(TEX.soft, 0x000000, "multiply");
  contactShadow.alpha = 0.55;
  world.addChild(contactShadow);

  let rocketTexture;
  let usingPlaceholder = false;
  try {
    rocketTexture = await PIXI.Assets.load(ASSET_PATH);
  } catch (e) {
    usingPlaceholder = true;
  }
  if (!rocketTexture) usingPlaceholder = true;
  if (usingPlaceholder) {
    console.error(`rocket_renderer: could not load ${ASSET_PATH}, using placeholder art`);
    rocketTexture = buildPlaceholderRocketTexture(PIXI);
  }
  const NOZZLE_POINTS = usingPlaceholder ? NOZZLE_POINTS_PLACEHOLDER : NOZZLE_POINTS_REAL;

  const rocketGroup = new PIXI.Container();
  world.addChild(rocketGroup);

  const rocketSprite = new PIXI.Sprite(rocketTexture);
  rocketSprite.anchor.set(0.5, 1);

  const rimLight = new PIXI.Sprite(rocketTexture);
  rimLight.anchor.set(0.5, 1);
  rimLight.tint = 0x6f9bff;
  rimLight.alpha = 0.35;
  rimLight.blendMode = "add";
  rimLight.scale.set(1.03);
  rimLight.position.set(3, 2);

  const warmUnderlight = softSprite(TEX.warmSpot, 0xffb347, "add");
  warmUnderlight.alpha = 0;

  rocketGroup.addChild(rimLight, rocketSprite, warmUnderlight);

  // `nozzleScale` is only the 1 / 0.62 main-vs-booster ratio — these base
  // sizes are NOT coupled to the rocket's actual on-screen render scale
  // (rocketSprite is scaled independently in layout()), so driveEngine()
  // additionally multiplies by s.rocketRenderScale every frame. Without
  // that, the plume envelope stays a fixed pixel size regardless of how
  // large the rocket renders — the root cause of the "thin laser line"
  // look at real viewport sizes. Base sizes below are large enough to read
  // as substantial exhaust columns once that scale is applied.
  function buildPlumeLayers(nozzleScale) {
    const c = new PIXI.Container();
    const glow = softSprite(TEX.plumeGlow, 0xffb347, "add");
    const outer = softSprite(TEX.outer, 0xff9d55, "add");
    const inner = softSprite(TEX.inner, 0xffd23d, "add");
    const core = softSprite(TEX.core, 0xffffff, "add");
    [glow, outer, inner, core].forEach((s) => {
      s.anchor.set(0.5, 0);
      c.addChild(s);
    });
    // Core/inner narrowed relative to outer/glow (was 95/46, now 80/34) —
    // total footprint unchanged, but the ratio between layers is sharper
    // so additive stacking near the top doesn't read as one bright column.
    glow.width = 170 * nozzleScale; glow.height = 160 * nozzleScale;
    outer.width = 150 * nozzleScale; outer.height = 190 * nozzleScale;
    inner.width = 80 * nozzleScale; inner.height = 150 * nozzleScale;
    core.width = 34 * nozzleScale; core.height = 80 * nozzleScale;
    c.userData = { glow, outer, inner, core };
    return c;
  }

  const plumes = NOZZLE_POINTS.map((p, i) => {
    const c = buildPlumeLayers(p.scale);
    c.visible = false;
    rocketGroup.addChild(c);
    return { container: c, point: p, isMain: i === 0 };
  });

  // Smoke: a PixiJS ParticleContainer (pixijs-scene-particle-container) —
  // a fixed pool of pre-created Particle structs, added ONCE and recycled
  // forever via a custom `_active` flag (never added/removed at runtime,
  // per pixijs-performance's "pool, don't allocate/destroy" guidance).
  // Three size/behavior layers (fresh vapor near the nozzle / turbulent
  // mid-smoke / soft distant cloud) plus per-particle drift, rotation,
  // lifetime and spawn-position variation replace the old single flat
  // layer of identical circles. Normal blending only — see pixijs-blend-
  // modes; a ParticleContainer shares one blend mode for its whole batch,
  // which fits since none of the smoke here is meant to glow.
  // Each particle gets a fixed `_side` (-1/+1) at spawn from which nozzle
  // it came from, so left-engine smoke drifts left, right-engine smoke
  // drifts right, and center-engine smoke splits — instead of a generic
  // "outward from birth point" jitter that just piles into one band.
  // `pushDown`/`outSpeed` drive a down-then-outward arc (see respawnSmoke
  // and the tick update): strong downward push fades out over the first
  // ~45% of life while outward drift ramps in, so smoke stays a thin fast
  // downward vapor right at the nozzle and only becomes a wide, dense mass
  // once it's below/beside the platform. warmPeak is deliberately low —
  // subtle illumination, not visible orange balls — and baseTint gives
  // each layer its own cool-toward-off-white starting color.
  const SMOKE_LAYERS = [
    { sizeMin: 0.40, sizeMax: 0.65, lifeRate: 1 / 1.5, pushDown: 74, outSpeed: 22, riseMin: 3, riseMax: 8, wobble: 0.3, warmPeak: 0.32, alphaPeak: 0.42, baseTint: 0xd6dbe4 },
    { sizeMin: 0.75, sizeMax: 1.3, lifeRate: 1 / 3.2, pushDown: 42, outSpeed: 36, riseMin: 4, riseMax: 10, wobble: 0.55, warmPeak: 0.16, alphaPeak: 0.4, baseTint: 0xa6afc2 },
    { sizeMin: 1.4, sizeMax: 2.3, lifeRate: 1 / 6.5, pushDown: 18, outSpeed: 48, riseMin: 2, riseMax: 6, wobble: 0.8, warmPeak: 0.06, alphaPeak: 0.32, baseTint: 0x7d879c },
  ];
  const SMOKE_N = 260;
  const smokeParticles = [];
  for (let i = 0; i < SMOKE_N; i++) {
    const particle = new PIXI.Particle({ texture: TEX.soft, anchorX: 0.5, anchorY: 0.5, alpha: 0 });
    particle._active = false;
    particle._life = 1;
    particle._layer = 0;
    particle._side = 1;
    particle._vDown = 0;
    particle._vOut = 0;
    particle._vRise = 0;
    particle._size = 1;
    particle._rotSpeed = 0;
    particle._seed = Math.random() * Math.PI * 2;
    smokeParticles.push(particle);
  }
  const smokeContainer = new PIXI.ParticleContainer({
    texture: TEX.soft,
    particles: smokeParticles,
    // position/rotation/scale(vertex)/tint+alpha(color) all animate every
    // frame; uvs stay static since every particle shares one plain texture.
    dynamicProperties: { position: true, rotation: true, color: true, vertex: true },
    boundsArea: new PIXI.Rectangle(0, 0, 1, 1), // real size set in layout()
    blendMode: "normal",
  });
  world.addChild(smokeContainer);

  function pickSmokeLayer(groupOn, launching) {
    const r = Math.random();
    if (launching || groupOn > 0.5) return r < 0.35 ? 0 : r < 0.7 ? 1 : 2;
    if (groupOn > 0.15) return r < 0.55 ? 0 : r < 0.85 ? 1 : 2;
    return r < 0.85 ? 0 : 1; // pre-ignition: mostly small fresh vapor
  }

  function respawnSmoke(p, x, y, outwardBias, layerIdx, side) {
    const layer = SMOKE_LAYERS[layerIdx];
    p._active = true;
    p._life = 0;
    p._layer = layerIdx;
    // Tight to the nozzle at birth — the wide spread happens later, as a
    // result of the outward drift, not from a scattered spawn point.
    p.x = x + (Math.random() - 0.5) * 10;
    p.y = y + Math.random() * 5;
    p._side = side;
    p._vDown = layer.pushDown * (0.7 + Math.random() * 0.6);
    p._vOut = layer.outSpeed * (0.7 + Math.random() * 0.6) + outwardBias;
    p._vRise = layer.riseMin + Math.random() * (layer.riseMax - layer.riseMin);
    p._size = layer.sizeMin + Math.random() * (layer.sizeMax - layer.sizeMin);
    p._rotSpeed = (Math.random() - 0.5) * 0.5;
    p.rotation = Math.random() * Math.PI * 2;
    p.alpha = 0.001;
  }

  return {
    TEX, world, sky, atmo, horizonGlow, horizon, buildStars,
    platform, gantry, gantryGfx, beacon, gantryLight, practicalLights,
    contactShadow, rocketTexture, rocketGroup, rocketSprite, rimLight, warmUnderlight,
    plumes, SMOKE_LAYERS, smokeContainer, smokeParticles, pickSmokeLayer, respawnSmoke,
    platformY: 0,
  };
}

function buildPlaceholderRocketTexture(PIXI) {
  // Defensive fallback only, used if assets/rocket/rocket.png fails to
  // load — not the intended rendering path.
  const w = 360, h = 900;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, "#8993ac"); grad.addColorStop(0.28, "#f7fafd");
  grad.addColorStop(0.6, "#d7dee8"); grad.addColorStop(1, "#5f6a86");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(w / 2, 30);
  ctx.bezierCurveTo(w * 0.75, 160, w * 0.82, 340, w * 0.82, 560);
  ctx.lineTo(w * 0.18, 560);
  ctx.bezierCurveTo(w * 0.18, 340, w * 0.25, 160, w / 2, 30);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#c7cede";
  [w * 0.1, w * 0.9].forEach((bx) => {
    ctx.beginPath();
    ctx.ellipse(bx, 420, 34, 190, 0, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = "#232c46";
  ctx.fillRect(w * 0.15, 560, w * 0.7, 90);
  ctx.beginPath();
  ctx.ellipse(w / 2, 660, w * 0.4, 26, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#182642";
  ctx.beginPath(); ctx.arc(w / 2, 220, 44, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#c7cede"; ctx.lineWidth = 6;
  ctx.beginPath(); ctx.arc(w / 2, 220, 50, 0, Math.PI * 2); ctx.stroke();
  return PIXI.Texture.from(c);
}

// --- layout (responsive to stage resize) ---------------------------------

function layout(PIXI, app, s) {
  const w = app.screen.width, h = app.screen.height;

  s.sky.clear();
  const skyStops = [[0, 0x03050b], [0.35, 0x0a1020], [0.65, 0x101a30], [1, 0x182440]];
  const bandH = h / (skyStops.length - 1);
  for (let i = 0; i < skyStops.length - 1; i++) {
    s.sky.rect(0, i * bandH, w, bandH + 1).fill({ color: skyStops[i][1] });
  }
  for (let i = 0; i < skyStops.length; i++) {
    s.sky.rect(0, 0, w, h).fill({ color: skyStops[i][1], alpha: 0.12 });
  }

  s.atmo.position.set(w / 2, h * 0.34);
  s.atmo.scale.set((w * 1.1) / s.TEX.glow.width, (h * 0.9) / s.TEX.glow.height);
  s.horizonGlow.position.set(w / 2, h * 0.82);
  s.horizonGlow.scale.set((w * 1.6) / s.TEX.glow.width, (h * 0.35) / s.TEX.glow.height);

  s.horizon.clear();
  s.horizon.moveTo(0, h * 0.86);
  s.horizon.bezierCurveTo(w * 0.2, h * 0.83, w * 0.4, h * 0.87, w * 0.62, h * 0.845);
  s.horizon.bezierCurveTo(w * 0.8, h * 0.825, w * 0.92, h * 0.855, w, h * 0.835);
  s.horizon.lineTo(w, h).lineTo(0, h).closePath();
  s.horizon.fill({ color: 0x070b16, alpha: 0.7 });

  s.buildStars(w, h);

  // Smoke can drift outward past the platform and rise well above it —
  // give the ParticleContainer's required boundsArea (see
  // pixijs-scene-particle-container) generous margin rather than
  // recomputing it precisely every frame.
  s.smokeContainer.boundsArea.x = -w * 0.2;
  s.smokeContainer.boundsArea.y = -h * 0.4;
  s.smokeContainer.boundsArea.width = w * 1.4;
  s.smokeContainer.boundsArea.height = h * 1.4;

  s.platformY = h * 0.82;
  const deckW = w * 0.34, deckH = h * 0.05;
  s.platform.clear();
  s.platform.roundRect(w / 2 - deckW / 2, s.platformY, deckW, deckH, 6).fill({ color: 0x1c2438 });
  s.platform.roundRect(w / 2 - deckW / 2, s.platformY, deckW, 4, 2).fill({ color: 0x39466c });
  s.platform.ellipse(w / 2, s.platformY + deckH + 10, deckW * 0.52, 10).fill({ color: 0x02030a, alpha: 0.55 });
  for (let i = 0; i < 4; i++) {
    const lx = w / 2 - deckW / 2 + (i + 0.5) * (deckW / 4);
    s.platform.rect(lx - 3, s.platformY + deckH, 6, 22).fill({ color: 0x141b2c });
  }

  s.gantry.position.set(w / 2 + deckW * 0.62, 0);
  s.gantryGfx.clear();
  const mastH = h * 0.42, mastTop = s.platformY + deckH - mastH;
  s.gantryGfx.rect(-4, mastTop, 8, mastH).fill({ color: 0x141b2c });
  for (let i = 0; i < 5; i++) {
    const y = mastTop + (i + 0.5) * (mastH / 5);
    s.gantryGfx.moveTo(-4, y - 14).lineTo(4, y + 14).stroke({ width: 2, color: 0x2e3a5c });
    s.gantryGfx.moveTo(4, y - 14).lineTo(-4, y + 14).stroke({ width: 2, color: 0x2e3a5c });
  }
  s.gantryGfx.rect(-70, mastTop + mastH * 0.28, 70, 5).fill({ color: 0x141b2c });
  s.beacon.position.set(0, mastTop - 6);
  s.beacon.scale.set(1.4);
  s.gantryLight.position.set(0, mastTop + mastH * 0.55);
  s.gantryLight.scale.set(1.1);

  s.practicalLights.forEach((l, i) => {
    const t = i / (s.practicalLights.length - 1);
    l.position.set(w / 2 - deckW / 2 + t * deckW, s.platformY + 2);
  });

  s.contactShadow.position.set(w / 2, s.platformY + deckH * 0.4);
  s.contactShadow.scale.set((deckW * 0.9) / s.TEX.soft.width, (deckH * 1.6) / s.TEX.soft.height);

  // Rocket display size is ~12% smaller than the VFX reference size (more
  // breathing room in the viewport), but s.rocketRenderScale — what
  // driveEngine()/the smoke system use to size the already-approved
  // flame/smoke — stays tied to the UNREDUCED reference height, so
  // shrinking the sprite does not also shrink exhaust intensity. Nozzle/
  // flame/smoke ORIGIN positions still correctly track the smaller rocket
  // via rocketSprite.width/height below (position follows the display
  // scale; VFX size does not).
  const vfxReferenceHeight = h * 0.66;
  const ROCKET_DISPLAY_SCALE = 0.88; // ~12% smaller
  const targetHeight = vfxReferenceHeight * ROCKET_DISPLAY_SCALE;
  const scaleFactor = targetHeight / s.rocketTexture.height;
  s.rocketSprite.scale.set(scaleFactor);
  s.rimLight.scale.set(scaleFactor * 1.03);
  s.rocketRenderScale = vfxReferenceHeight / s.rocketTexture.height;
  s.rocketGroup.baseX = w / 2;
  s.rocketGroup.baseY = s.platformY + deckH * 0.35;
  s.rocketGroup.position.set(s.rocketGroup.baseX, s.rocketGroup.baseY);

  s.warmUnderlight.position.set(0, -s.rocketSprite.height * 0.14);
  s.warmUnderlight.scale.set((s.rocketSprite.width * 0.9) / s.TEX.warmSpot.width, (s.rocketSprite.height * 0.32) / s.TEX.warmSpot.height);

  s.plumes.forEach(({ container, point }) => {
    const localX = (point.x - 0.5) * s.rocketSprite.width;
    const localY = -(1 - point.y) * s.rocketSprite.height;
    container.position.set(localX, localY);
  });
}

// --- per-frame drive -------------------------------------------------------

function driveEngine(container, base, freqA, freqB, engPhase, t, renderScale) {
  // Turbulence speeds up as the engine gets hotter ("faster turbulent
  // movement" near max), on top of the existing amplitude scaling.
  const freqMul = 1 + base * 0.5;
  const flick = Math.sin(t * freqA * freqMul + engPhase) * 0.5 + Math.sin(t * freqB * freqMul + engPhase * 1.7) * 0.5;
  const lenBase = Math.pow(base, 1.6);
  const len = (0.3 + lenBase * 2.3) * (1 + flick * 0.2);
  const wid = (0.55 + base * 0.85) * (1 + flick * 0.1);
  const { glow, outer, inner, core } = container.userData;
  // Restrained additive glow — support light, not the plume shape itself.
  glow.alpha = Math.min(1, base * 0.9);
  outer.alpha = base;
  inner.alpha = base;
  core.alpha = base;
  // Couples the envelope to the rocket's actual on-screen size (see
  // buildPlumeLayers) — without this the plume stays a fixed pixel size
  // no matter how large the rocket renders.
  const rs = renderScale || 1;
  container.scale.set(wid * rs, len * rs);

  // Subtle independent width/position turbulence per layer (cheap: just
  // nudges each child sprite's own transform, no new sprites/textures) so
  // the plume reads as an organically wobbling exhaust rather than a
  // static, perfectly-nested taper.
  const w1 = Math.sin(t * 6.5 + engPhase) * base;
  const w2 = Math.sin(t * 8.1 + engPhase + 2.1) * base;
  const w3 = Math.sin(t * 11 + engPhase + 4.2) * base;
  outer.scale.x = 1 + w1 * 0.14;
  outer.position.x = w1 * 3;
  inner.scale.x = 1 + w2 * 0.12;
  inner.position.x = w2 * 2.2;
  core.scale.x = 1 + w3 * 0.09;
  core.position.x = w3 * 1.4;
}

function mixColor(a, b, t) {
  t = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

function tick(ticker) {
  const s = scene;
  if (!s) return;
  const dt = ticker.deltaMS / 1000;
  phase += dt;
  const t = phase;

  energy += (targetEnergy - energy) * Math.min(1, dt * 3);

  // Gentle intermittent pulse through the "subtle engine activity" window
  // instead of a flat monotonic rise, and saturates later (0.80 not 0.68)
  // so it doesn't already look launch-ready at 70%.
  const engineGlow = smoothstep(0.35, 0.80, energy) * (0.85 + 0.15 * Math.sin(t * 1.7));
  const flameMainI = ignitionCurve(energy, MAIN_IGNITE_START);
  const flameBoostI = ignitionCurve(energy, BOOST_IGNITE_START);
  const vibI = smoothstep(0.40, 0.98, energy);
  const vaporI = smoothstep(0.20, 0.95, energy);
  const groupOn = Math.max(flameMainI, flameBoostI);
  const dangerI = smoothstep(0.85, 0.99, energy); // extra "seconds away" push

  s.warmUnderlight.alpha = engineGlow * 0.55 + groupOn * 0.35;
  s.gantryLight.alpha = 0.25 + engineGlow * 0.35;
  s.practicalLights.forEach((l, i) => { l.alpha = 0.35 + engineGlow * 0.3 + Math.sin(t * (2 + i)) * 0.05; });
  s.beacon.alpha = 0.6 + Math.sin(t * 1.6) * 0.3;
  s.contactShadow.alpha = 0.55 - groupOn * 0.15;

  if (!launching) {
    const freqMul = 1 + dangerI * 0.7;
    const shakeX = (Math.sin(t * 37 * freqMul) * 0.6 + Math.sin(t * 71 * freqMul + 1.3) * 0.4) * vibI * (2.4 + dangerI * 1.8);
    const shakeY = Math.sin(t * 43 * freqMul + 0.5) * 0.5 * vibI * (1.6 + dangerI * 1.2);
    s.rocketGroup.position.set(s.rocketGroup.baseX + shakeX, s.rocketGroup.baseY + shakeY);

    s.world.position.set((Math.random() - 0.5) * dangerI * 4, (Math.random() - 0.5) * dangerI * 4);
  }

  s.plumes.forEach((pl, i) => {
    const base = pl.isMain ? flameMainI : flameBoostI;
    pl.container.visible = base > 0.01 || launching;
    if (!launching) driveEngine(pl.container, base, 29 + i * 4, 53 + i * 5, 0.7 + i * 1.3, t, s.rocketRenderScale);
  });

  // Denser, further-spreading smoke as energy rises — spawn rate, size,
  // and horizontal reach all scale up so particles overlap into
  // continuous clouds instead of staying isolated puffs.
  const spawnRate = launching ? 6 : Math.max(0.25, vaporI * 2.2 + groupOn * 4.2);
  let toSpawn = spawnRate * dt * 34;
  const renderScale = s.rocketRenderScale || 1;
  for (const p of s.smokeParticles) {
    if (!p._active) continue;
    const layer = s.SMOKE_LAYERS[p._layer];
    p._life += dt * layer.lifeRate;
    if (p._life >= 1) { p._active = false; p.alpha = 0; continue; }
    // Down-then-outward arc: downW dominates near birth (fast, thin vapor
    // right at the nozzle, nozzle bells stay clear), outW takes over as
    // the particle ages (expands outward to its assigned side, gently
    // rising) — this is what turns one flat band into two spreading
    // masses instead of a generic "outward from birth" jitter.
    const downW = Math.max(0, 1 - p._life * 2.2) ** 2;
    const outW = Math.min(1, p._life * 1.6);
    p.x += (p._vOut * p._side * outW + Math.sin(t * (0.6 + p._layer * 0.2) + p._seed) * layer.wobble) * dt * renderScale;
    p.y += (p._vDown * downW - p._vRise * outW) * dt * renderScale;
    p.rotation += p._rotSpeed * dt;
    const growth = 0.6 + p._life * 1.9;
    const px = (p._size * growth * 90 * renderScale) / s.TEX.soft.width;
    p.scaleX = px; p.scaleY = px;
    // Opacity builds from near-zero at the nozzle (a fast, barely-visible
    // vapor jet) to a peak mid-life once it's spread into a cloud, then
    // fades — never a solid glowing blob at birth.
    const hump = 4 * p._life * (1 - p._life);
    const warm = Math.max(0, 1 - p._life * 1.8) * layer.warmPeak * (vaporI * 0.35 + groupOn * 0.45 + (launching ? 0.4 : 0));
    p.tint = mixColor(layer.baseTint, 0xfff0d8, warm);
    p.alpha = hump * layer.alphaPeak * (0.6 + vaporI * 0.3 + groupOn * 0.4 + (launching ? 0.4 : 0));
  }
  if ((vaporI > 0.02 || groupOn > 0.02 || launching) && toSpawn > 0) {
    const outwardBias = (launching ? 34 : 8 + groupOn * 20) * renderScale;
    // Spawn under each of the three nozzles, each with a FIXED side bias
    // (left engine -> left, right engine -> right, center engine splits
    // both ways) so the smoke resolves into two masses flanking a clearer
    // center, with all three nozzle bells staying visible above it.
    for (const p of s.smokeParticles) {
      if (p._active) continue;
      if (toSpawn-- <= 0) break;
      const layerIdx = s.pickSmokeLayer(groupOn, launching);
      const nozzle = s.plumes[Math.floor(Math.random() * s.plumes.length)];
      const spawnX = s.rocketGroup.baseX + nozzle.container.x;
      const side = nozzle.isMain ? (Math.random() < 0.5 ? -1 : 1) : (nozzle.point.x < 0.5 ? -1 : 1);
      s.respawnSmoke(p, spawnX, s.platformY, outwardBias, layerIdx, side);
    }
  }

  if (launching) {
    launchT += dt;
    s.plumes.forEach((pl) => { pl.container.visible = true; });
    if (launchT <= LAUNCH_HOLD) {
      const e = launchT / LAUNCH_HOLD;
      s.plumes.forEach((pl, i) => driveEngine(pl.container, Math.min(1, pl.isMain ? 1 : e * 1.3), 29 + i * 4, 53 + i * 5, 0.7 + i * 1.3, t, s.rocketRenderScale));
      s.rocketGroup.position.set(s.rocketGroup.baseX, s.rocketGroup.baseY + e * 4);
      s.warmUnderlight.alpha = 0.9;
    } else {
      const e = Math.min(1, (launchT - LAUNCH_HOLD) / LAUNCH_RISE);
      const ease = 1 - Math.pow(1 - e, 2.6);
      s.rocketGroup.position.set(s.rocketGroup.baseX, s.rocketGroup.baseY + 4 - ease * (app.screen.height * 1.15));
      const stretch = 1 + ease * 2.4;
      s.plumes.forEach((pl, i) => {
        driveEngine(pl.container, pl.isMain ? 1 : 0.88, 29 + i * 4, 53 + i * 5, 0.7 + i * 1.3, t, s.rocketRenderScale);
        pl.container.scale.y *= pl.isMain ? stretch : stretch * 0.8;
      });
      s.rocketGroup.alpha = 1 - Math.max(0, e - 0.85) / 0.15;
      if (launchT >= LAUNCH_TOTAL) finishLaunch();
    }
  }
}

function finishLaunch() {
  launching = false;
  const cb = launchOnComplete;
  launchOnComplete = null;
  if (cb) cb();
}
