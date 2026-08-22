// Rocket — PixiJS POC
// Standalone experiment. Not wired into QuietClass. See index.html.
//
// Layout: one `world` container holds every scene layer (sky, stars,
// platform, gantry, rocket) and is the thing screen-shake nudges; the HTML
// HUD sits above the canvas and is unaffected by shake. `rocketGroup` holds
// the rocket sprite + its light overlays + all three engine plumes, so the
// launch sequence only has to move ONE container for everything to stay
// physically attached.

(async () => {
  const app = new PIXI.Application();
  await app.init({
    resizeTo: window,
    background: 0x04060c,
    antialias: true,
    resolution: Math.min(devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  document.getElementById("pixi-root").appendChild(app.canvas);

  // --- reusable soft-gradient textures (generated once, shared by many sprites) ---
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

  // A tapered, soft-edged directional plume shape (narrow+bright at the
  // top/nozzle, widening downward, fading toward the tail) — replaces a
  // plain radial gradient stretched into an ellipse, which reads as a
  // round blob rather than directional thrust. `stops` are {t, widthFrac,
  // alpha} from nozzle (t=0) to tail (t=1); each horizontal slice is its
  // own left-right gradient so every edge (top/bottom/left/right) is soft.
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
    core: coneTexture(48, 128, "255,250,235", [
      { t: 0, widthFrac: 0.42, alpha: 1.0 }, { t: 0.25, widthFrac: 0.32, alpha: 0.95 },
      { t: 0.6, widthFrac: 0.22, alpha: 0.4 }, { t: 1, widthFrac: 0.12, alpha: 0 },
    ]),
    inner: coneTexture(64, 144, "255,210,61", [
      { t: 0, widthFrac: 0.58, alpha: 0.95 }, { t: 0.35, widthFrac: 0.55, alpha: 0.8 },
      { t: 0.7, widthFrac: 0.42, alpha: 0.35 }, { t: 1, widthFrac: 0.26, alpha: 0 },
    ]),
    outer: coneTexture(80, 160, "255,122,61", [
      { t: 0, widthFrac: 0.46, alpha: 0.85 }, { t: 0.3, widthFrac: 0.6, alpha: 0.65 },
      { t: 0.65, widthFrac: 0.82, alpha: 0.32 }, { t: 1, widthFrac: 0.95, alpha: 0 },
    ]),
    // Support-only ambient halo for the plume — deliberately low-alpha and
    // elongated (not round) so it no longer reads as the flame shape itself.
    plumeGlow: coneTexture(96, 176, "255,157,63", [
      { t: 0, widthFrac: 0.65, alpha: 0.22 }, { t: 0.4, widthFrac: 0.9, alpha: 0.15 },
      { t: 0.8, widthFrac: 0.95, alpha: 0.06 }, { t: 1, widthFrac: 0.85, alpha: 0 },
    ]),
    // Shared with sky atmosphere/horizon glow below — left as a plain
    // round radial gradient; do not repurpose for the plume shape.
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

  // --- world container (screen-shake target) -------------------------------
  const world = new PIXI.Container();
  app.stage.addChild(world);

  // --- sky / atmosphere ------------------------------------------------------
  const sky = new PIXI.Graphics();
  const atmo = softSprite(TEX.glow, 0x5a4dff, "add");
  atmo.alpha = 0.5;
  const horizonGlow = softSprite(TEX.glow, 0x3d5a80, "add");
  horizonGlow.alpha = 0.5;
  const horizon = new PIXI.Graphics();
  world.addChild(sky, atmo, horizonGlow, horizon);

  // stars: baked once onto a single texture (cheap — one sprite, not N)
  let starsSprite;
  function buildStars(w, h) {
    if (starsSprite) starsSprite.destroy();
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
  const starTwinkle = new PIXI.Container(); // placeholder index anchor (twinkle done via global alpha pulse)

  // --- platform / gantry -------------------------------------------------
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

  // contact shadow under the rocket
  const contactShadow = softSprite(TEX.soft, 0x000000, "multiply");
  contactShadow.alpha = 0.55;
  world.addChild(contactShadow);

  // --- rocket --------------------------------------------------------------
  const ASSET_PATH = "assets/rocket.png";
  let rocketTexture;
  let usingPlaceholder = false;
  try {
    rocketTexture = await PIXI.Assets.load(ASSET_PATH);
  } catch (e) {
    usingPlaceholder = true;
  }
  if (!rocketTexture) usingPlaceholder = true;
  if (usingPlaceholder) {
    document.getElementById("assetWarning").style.display = "block";
    rocketTexture = buildPlaceholderRocketTexture();
  }

  // Fractional nozzle attachment points within the rocket image
  // (0,0 = top-left, 1,1 = bottom-right). The real-asset values were
  // measured directly off assets/rocket.png (centroid of the two dark
  // booster-nozzle blobs + the small central engine mount between them).
  // Real-asset values measured directly off assets/rocket.png (centroids of
  // the three metal nozzle-bell blobs, at the exact row the baked flame
  // artwork was cropped from).
  const NOZZLE_POINTS = usingPlaceholder
    ? [{ x: 0.5, y: 0.955, scale: 1 }, { x: 0.30, y: 0.92, scale: 0.62 }, { x: 0.70, y: 0.92, scale: 0.62 }]
    : [{ x: 0.5025, y: 0.9965, scale: 1 }, { x: 0.2284, y: 0.9965, scale: 0.62 }, { x: 0.7394, y: 0.9965, scale: 0.62 }];

  const rocketGroup = new PIXI.Container();
  world.addChild(rocketGroup);

  const rocketSprite = new PIXI.Sprite(rocketTexture);
  rocketSprite.anchor.set(0.5, 1);

  // Cool rim light: a slightly larger, blue-tinted, low-alpha copy behind
  // the rocket — reads as ambient sky light catching the hull edge.
  const rimLight = new PIXI.Sprite(rocketTexture);
  rimLight.anchor.set(0.5, 1);
  rimLight.tint = 0x6f9bff;
  rimLight.alpha = 0.35;
  rimLight.blendMode = "add";
  rimLight.scale.set(1.03);
  rimLight.position.set(3, 2);

  // Warm engine-light overlay on the rocket's lower body — a soft warm
  // spot masked (via position + blend) to sit near the engine section,
  // faded in as energy rises.
  const warmUnderlight = softSprite(TEX.warmSpot, 0xffb347, "add");
  warmUnderlight.alpha = 0;

  rocketGroup.addChild(rimLight, rocketSprite, warmUnderlight);

  // --- exhaust plumes --------------------------------------------------------
  function buildPlumeLayers(scale) {
    const c = new PIXI.Container();
    // Support-only halo, uses the dedicated plumeGlow texture (not the
    // shared TEX.glow atmo/horizon texture) and is now the SMALLEST/lowest
    // opacity layer instead of the biggest — it should read as ambient
    // light around the plume, not as the plume itself.
    const glow = softSprite(TEX.plumeGlow, 0xffb347, "add");
    const outer = softSprite(TEX.outer, 0xff9d55, "add");
    const inner = softSprite(TEX.inner, 0xffd23d, "add");
    const core = softSprite(TEX.core, 0xffffff, "add");
    [glow, outer, inner, core].forEach((s) => {
      s.anchor.set(0.5, 0); // top-anchored: growth extends downward from the nozzle
      c.addChild(s);
    });
    // Tall/narrow envelopes (height >> width) so the baked-in taper reads
    // as directional thrust; glow shrunk well below the colored layers.
    glow.width = 46 * scale; glow.height = 92 * scale;
    outer.width = 30 * scale; outer.height = 100 * scale;
    inner.width = 19 * scale; inner.height = 74 * scale;
    core.width = 8 * scale; core.height = 32 * scale;
    c.userData = { glow, outer, inner, core, baseScale: scale };
    return c;
  }

  const plumes = NOZZLE_POINTS.map((p, i) => {
    const c = buildPlumeLayers(p.scale);
    c.visible = false;
    rocketGroup.addChild(c);
    return { container: c, point: p, isMain: i === 0 };
  });

  // --- smoke pool (fixed-size, reused every frame — never rebuilt) --------
  const SMOKE_N = 90;
  const smokePool = [];
  const smokeLayer = new PIXI.Container();
  world.addChild(smokeLayer);
  for (let i = 0; i < SMOKE_N; i++) {
    const s = softSprite(TEX.soft, 0xaab4c8, "normal");
    s.visible = false;
    smokeLayer.addChild(s);
    smokePool.push({ sprite: s, life: 1, vx: 0, vy: 0, seed: Math.random() * 1000, size: 1 });
  }
  function respawnSmoke(p, x, y, spread, burst) {
    p.life = 0;
    p.sprite.position.set(x + (Math.random() - 0.5) * spread, y + (Math.random() - 0.5) * 8);
    p.vx = (Math.random() - 0.5) * (burst ? 90 : 24);
    p.vy = -(burst ? 40 + Math.random() * 60 : 10 + Math.random() * 18);
    p.size = 0.5 + Math.random() * 0.5;
    p.sprite.visible = true;
  }

  // --- layout (responsive to resize) ---------------------------------------
  let platformY = 0;
  function layout() {
    const w = app.screen.width, h = app.screen.height;

    sky.clear();
    const skyStops = [[0, 0x03050b], [0.35, 0x0a1020], [0.65, 0x101a30], [1, 0x182440]];
    const bandH = h / (skyStops.length - 1);
    for (let i = 0; i < skyStops.length - 1; i++) {
      sky.rect(0, i * bandH, w, bandH + 1).fill({ color: skyStops[i][1] });
    }
    // simple vertical blend pass using translucent bands on top
    for (let i = 0; i < skyStops.length; i++) {
      sky.rect(0, 0, w, h).fill({ color: skyStops[i][1], alpha: 0.12 });
    }

    atmo.position.set(w / 2, h * 0.34);
    atmo.scale.set((w * 1.1) / TEX.glow.width, (h * 0.9) / TEX.glow.height);
    horizonGlow.position.set(w / 2, h * 0.82);
    horizonGlow.scale.set((w * 1.6) / TEX.glow.width, (h * 0.35) / TEX.glow.height);

    horizon.clear();
    horizon.moveTo(0, h * 0.86);
    horizon.bezierCurveTo(w * 0.2, h * 0.83, w * 0.4, h * 0.87, w * 0.62, h * 0.845);
    horizon.bezierCurveTo(w * 0.8, h * 0.825, w * 0.92, h * 0.855, w, h * 0.835);
    horizon.lineTo(w, h).lineTo(0, h).closePath();
    horizon.fill({ color: 0x070b16, alpha: 0.7 });

    buildStars(w, h);

    platformY = h * 0.82;
    const deckW = w * 0.34, deckH = h * 0.05;
    platform.clear();
    platform.roundRect(w / 2 - deckW / 2, platformY, deckW, deckH, 6).fill({ color: 0x1c2438 });
    platform.roundRect(w / 2 - deckW / 2, platformY, deckW, 4, 2).fill({ color: 0x39466c });
    platform.ellipse(w / 2, platformY + deckH + 10, deckW * 0.52, 10).fill({ color: 0x02030a, alpha: 0.55 });
    for (let i = 0; i < 4; i++) {
      const lx = w / 2 - deckW / 2 + (i + 0.5) * (deckW / 4);
      platform.rect(lx - 3, platformY + deckH, 6, 22).fill({ color: 0x141b2c });
    }

    gantry.position.set(w / 2 + deckW * 0.62, 0);
    gantryGfx.clear();
    const mastH = h * 0.42, mastTop = platformY + deckH - mastH;
    gantryGfx.rect(-4, mastTop, 8, mastH).fill({ color: 0x141b2c });
    for (let i = 0; i < 5; i++) {
      const y = mastTop + (i + 0.5) * (mastH / 5);
      gantryGfx.moveTo(-4, y - 14).lineTo(4, y + 14).stroke({ width: 2, color: 0x2e3a5c });
      gantryGfx.moveTo(4, y - 14).lineTo(-4, y + 14).stroke({ width: 2, color: 0x2e3a5c });
    }
    gantryGfx.rect(-70, mastTop + mastH * 0.28, 70, 5).fill({ color: 0x141b2c });
    beacon.position.set(0, mastTop - 6);
    beacon.scale.set(1.4);
    gantryLight.position.set(0, mastTop + mastH * 0.55);
    gantryLight.scale.set(1.1);

    practicalLights.forEach((l, i) => {
      const t = i / (practicalLights.length - 1);
      l.position.set(w / 2 - deckW / 2 + t * deckW, platformY + 2);
    });

    contactShadow.position.set(w / 2, platformY + deckH * 0.4);
    contactShadow.scale.set((deckW * 0.9) / TEX.soft.width, (deckH * 1.6) / TEX.soft.height);

    // rocket: large, dominant, base pinned to the deck, aspect preserved
    const targetHeight = h * 0.66;
    const s = targetHeight / rocketTexture.height;
    rocketSprite.scale.set(s);
    rimLight.scale.set(s * 1.03);
    rocketGroup.baseX = w / 2;
    rocketGroup.baseY = platformY + deckH * 0.35;
    rocketGroup.position.set(rocketGroup.baseX, rocketGroup.baseY);

    warmUnderlight.position.set(0, -rocketSprite.height * 0.14);
    warmUnderlight.scale.set((rocketSprite.width * 0.9) / TEX.warmSpot.width, (rocketSprite.height * 0.32) / TEX.warmSpot.height);

    plumes.forEach(({ container, point }) => {
      const localX = (point.x - 0.5) * rocketSprite.width;
      const localY = -(1 - point.y) * rocketSprite.height;
      container.position.set(localX, localY);
    });
  }

  function buildPlaceholderRocketTexture() {
    // Simple stand-in so the POC runs before real art is dropped in —
    // deliberately not meant to be the "premium" asset itself.
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
    // boosters
    ctx.fillStyle = "#c7cede";
    [w * 0.1, w * 0.9].forEach((bx) => {
      ctx.beginPath();
      ctx.ellipse(bx, 420, 34, 190, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    // engine skirt
    ctx.fillStyle = "#232c46";
    ctx.fillRect(w * 0.15, 560, w * 0.7, 90);
    ctx.beginPath();
    ctx.ellipse(w / 2, 660, w * 0.4, 26, 0, 0, Math.PI * 2);
    ctx.fill();
    // window
    ctx.fillStyle = "#182642";
    ctx.beginPath(); ctx.arc(w / 2, 220, 44, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#c7cede"; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(w / 2, 220, 50, 0, Math.PI * 2); ctx.stroke();
    return PIXI.Texture.from(c);
  }

  layout();
  window.addEventListener("resize", layout);

  // --- HUD wiring ------------------------------------------------------------
  const slider = document.getElementById("devSlider");
  const devEnergyValue = document.getElementById("devEnergyValue");
  const devLaunch = document.getElementById("devLaunch");
  const devReset = document.getElementById("devReset");
  const meterFill = document.getElementById("meterFill");
  const meterPercent = document.getElementById("meterPercent");
  const meterStatus = document.getElementById("meterStatus");
  const pauseBtn = document.getElementById("pauseBtn");
  const endBtn = document.getElementById("endBtn");

  let targetEnergy = 0, energy = 0;
  let launching = false, launchT = 0;
  const LAUNCH_HOLD = 0.45, LAUNCH_RISE = 2.6, LAUNCH_TOTAL = LAUNCH_HOLD + LAUNCH_RISE;

  function resetAll() {
    launching = false; launchT = 0;
    targetEnergy = 0; energy = 0;
    slider.value = 0; devEnergyValue.textContent = "0%";
    rocketGroup.position.set(rocketGroup.baseX, rocketGroup.baseY);
    rocketGroup.alpha = 1;
    world.position.set(0, 0);
    plumes.forEach((pl) => (pl.container.visible = false));
  }

  slider.addEventListener("input", () => {
    targetEnergy = Number(slider.value) / 100;
    devEnergyValue.textContent = `${slider.value}%`;
  });
  devLaunch.addEventListener("click", () => { slider.value = 100; targetEnergy = 1; devEnergyValue.textContent = "100%"; });
  devReset.addEventListener("click", resetAll);
  endBtn.addEventListener("click", resetAll);
  pauseBtn.addEventListener("click", () => {
    if (app.ticker.started) { app.ticker.stop(); pauseBtn.textContent = "Resume"; }
    else { app.ticker.start(); pauseBtn.textContent = "Pause"; }
  });

  function bandFor(e) {
    if (launching) return ["launch", "Launch"];
    if (e >= 0.85) return ["final", "Final Warning"];
    if (e >= 0.70) return ["warning", "Warning"];
    if (e >= 0.40) return ["building", "Building"];
    return ["safe", "Safe"];
  }

  const smoothstep = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };

  function driveEngine(container, base, freqA, freqB, phase, t) {
    const flick = Math.sin(t * freqA + phase) * 0.5 + Math.sin(t * freqB + phase * 1.7) * 0.5;
    // base**1.6 keeps 70-85% short (a short narrow plume just igniting)
    // and makes 85-99% grow dramatically, rather than a flat linear ramp.
    const lenBase = Math.pow(base, 1.6);
    const len = (0.22 + lenBase * 1.9) * (1 + flick * 0.18);
    const wid = (0.5 + base * 0.5) * (1 + flick * 0.09);
    const { glow, outer, inner, core } = container.userData;
    [glow, outer, inner, core].forEach((s) => { s.alpha = base; });
    container.scale.set(wid, len);
  }

  let phase = 0;
  app.ticker.add((ticker) => {
    const dt = ticker.deltaMS / 1000;
    phase += dt;
    const t = phase;

    energy += (targetEnergy - energy) * Math.min(1, dt * 3);

    const pct = Math.round(energy * 100);
    meterFill.style.width = `${pct}%`;
    meterPercent.textContent = `${pct}%`;
    const [band, label] = bandFor(energy);
    meterStatus.textContent = label;
    meterStatus.dataset.band = band;

    if (!launching && energy >= 0.995) { launching = true; launchT = 0; world.position.set(0, 0); }

    const engineGlow = smoothstep(0.32, 0.68, energy);
    const engineCore = smoothstep(0.48, 0.97, energy);
    const flameMainI = smoothstep(0.70, 0.99, energy);
    const flameBoostI = smoothstep(0.80, 0.99, energy);
    const vibI = smoothstep(0.40, 0.98, energy);
    const vaporI = smoothstep(0.15, 0.75, energy);
    const groupOn = Math.max(flameMainI, flameBoostI);

    // rocket underlight + practical/gantry light "illusion" of real lighting
    warmUnderlight.alpha = engineGlow * 0.55 + groupOn * 0.35;
    gantryLight.alpha = 0.25 + engineGlow * 0.35;
    practicalLights.forEach((l, i) => { l.alpha = 0.35 + engineGlow * 0.3 + Math.sin(t * (2 + i)) * 0.05; });
    beacon.alpha = 0.6 + Math.sin(t * 1.6) * 0.3;
    contactShadow.alpha = 0.55 - groupOn * 0.15;

    // vibration (independent, restrained; skipped once actually launching)
    if (!launching) {
      const shakeX = (Math.sin(t * 37) * 0.6 + Math.sin(t * 71 + 1.3) * 0.4) * vibI * 2.4;
      const shakeY = Math.sin(t * 43 + 0.5) * 0.5 * vibI * 1.6;
      rocketGroup.position.set(rocketGroup.baseX + shakeX, rocketGroup.baseY + shakeY);
    }
    // restrained screen shake once truly launch-imminent
    if (!launching) {
      const finalI = smoothstep(0.85, 0.99, energy);
      world.position.set((Math.random() - 0.5) * finalI * 3, (Math.random() - 0.5) * finalI * 3);
    }

    plumes.forEach((pl, i) => {
      const base = pl.isMain ? flameMainI : flameBoostI;
      pl.container.visible = base > 0.01 || launching;
      if (!launching) driveEngine(pl.container, base, 29 + i * 4, 53 + i * 5, 0.7 + i * 1.3, t);
    });

    // smoke: continuous light vapor pre-ignition, heavier/warmer once igniting
    const spawnRate = launching ? 3 : Math.max(0.15, vaporI * 1.4 + groupOn * 2);
    let toSpawn = spawnRate * dt * 30;
    for (const p of smokePool) {
      if (!p.sprite.visible) continue;
      p.life += dt * 0.35;
      if (p.life >= 1) { p.sprite.visible = false; continue; }
      p.sprite.x += p.vx * dt;
      p.sprite.y += p.vy * dt + t * 0; // keep linter-friendly; vy already carries drift
      p.vy *= 0.995;
      const s = p.size * (0.6 + p.life * 1.8);
      p.sprite.scale.set((s * 60) / TEX.soft.width);
      const warm = Math.max(0, 1 - p.life * 1.6) * (vaporI * 0.6 + groupOn * 0.7 + (launching ? 0.6 : 0));
      p.sprite.tint = mixColor(0x9aa4b8, 0xffb347, warm);
      p.sprite.alpha = (1 - p.life) * (0.35 + vaporI * 0.3 + groupOn * 0.3 + (launching ? 0.3 : 0));
    }
    if ((vaporI > 0.02 || groupOn > 0.02 || launching) && toSpawn > 0) {
      for (const p of smokePool) {
        if (p.sprite.visible) continue;
        if (toSpawn-- <= 0) break;
        const spreadX = rocketGroup.baseX + (Math.random() - 0.5) * (launching ? 140 : 40);
        respawnSmoke(p, spreadX, platformY, launching ? 60 : 20 + groupOn * 26, launching || groupOn > 0.3);
      }
    }

    // launch sequence
    if (launching) {
      launchT += dt;
      plumes.forEach((pl) => { pl.container.visible = true; });
      if (launchT <= LAUNCH_HOLD) {
        const e = launchT / LAUNCH_HOLD;
        plumes.forEach((pl, i) => driveEngine(pl.container, Math.min(1, pl.isMain ? 1 : e * 1.3), 29 + i * 4, 53 + i * 5, 0.7 + i * 1.3, t));
        rocketGroup.position.set(rocketGroup.baseX, rocketGroup.baseY + e * 4); // brief compress
        warmUnderlight.alpha = 0.9;
      } else {
        const e = Math.min(1, (launchT - LAUNCH_HOLD) / LAUNCH_RISE);
        const ease = 1 - Math.pow(1 - e, 2.6);
        rocketGroup.position.set(rocketGroup.baseX, rocketGroup.baseY + 4 - ease * (app.screen.height * 1.15));
        const stretch = 1 + ease * 2.4;
        // Main engine reads as strongest/longest; boosters run slightly
        // shorter/dimmer so the three plumes aren't visually identical.
        plumes.forEach((pl, i) => {
          driveEngine(pl.container, pl.isMain ? 1 : 0.88, 29 + i * 4, 53 + i * 5, 0.7 + i * 1.3, t);
          pl.container.scale.y *= pl.isMain ? stretch : stretch * 0.8;
        });
        rocketGroup.alpha = 1 - Math.max(0, e - 0.85) / 0.15;
        if (launchT >= LAUNCH_TOTAL) resetAll();
      }
    }
  });

  function mixColor(a, b, t) {
    t = Math.max(0, Math.min(1, t));
    const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    const r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t);
    return (r << 16) | (g << 8) | bl;
  }
})();
