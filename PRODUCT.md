# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are K–7 classroom teachers. They run QuietClass during independent work, quiet work, and other classroom focus periods. The teacher operates the app from a classroom computer, projector, or smartboard while the whole class participates as viewers/listeners — there is no requirement for students to have individual devices.

## Product Purpose

QuietClass turns classroom noise management into a visual mission-based game. Instead of watching a generic decibel meter, classroom noise drives a themed mission in real time (e.g. waking a dragon, launching a rocket). Success means students notice the visual consequence of noise and self-regulate without the teacher repeatedly interrupting independent work to ask for quiet.

## Positioning

The product's identity is "classroom focus turned into a game," not "a professional sound-measurement tool." The primary differentiator is the mission-based visual experience itself — themed worlds where noise has a visible, dramatic consequence — not the underlying noise-measurement technology.

Room calibration and sensitivity are supporting features that make the experience fair and adaptable across different classrooms and microphones. They exist so the mission experience works correctly everywhere, but they are secondary to the mission and must stay simple and out of the way in the UI rather than becoming a visible "instrument panel."

## Operating Context

- Run live during independent/quiet work time, controlled by one teacher, displayed to the whole class on a shared screen (smartboard/projector/classroom monitor).
- Teacher sets up a mission (theme + duration, optional calibration/sensitivity) and starts it in seconds — fast setup is a hard requirement, not a nice-to-have.
- During a mission, students are only half-watching while doing independent work; the meter/timer/state must be legible from across the room, at a glance, without close reading.
- No individual student devices or logins are part of the core classroom loop.

## Capabilities and Constraints

- No audio is recorded, uploaded, or stored. Microphone audio is processed live only and discarded — this is a binding privacy commitment already stated in the product UI (index.html).
- Must run smoothly on older Chromebooks, classroom laptops, and smartboard/projector setups — no heavy per-frame DOM work, no Canvas/WebGL unless explicitly added later.
- No student accounts or logins, ever, for core use.
- Existing pipeline: raw mic level → calibration-derived thresholds → noise state → Wake Meter → active theme. Calibration answers "what does this room normally sound like"; Sensitivity answers "how tolerant should QuietClass be above that."
- Theme system: each mission theme is its own explicit-named module set (e.g. `dragon_theme.js`/`dragon_renderer.js`, `rocket_theme.js`/`rocket_renderer.js`/`rocket_scene.js`) registered through a shared `themeRegistry` contract (id, name, thumbnail, copy strings, mount/updateProgress/triggerFailEvent/resolveFailEvent/onSessionEnd/unmount). New mission worlds (e.g. weather) follow the same pattern.
- Current themes: Dragon ("Keep the Dragon Asleep") and Rocket ("Keep the Rocket Grounded").
- Scope discipline: QuietClass should solve classroom noise/focus exceptionally well before expanding into unrelated classroom-management features.

## Brand Commitments

- Name: QuietClass. Tagline in current UI: "Make quiet time feel like a mission."
- Voice/tone: playful, game-like, mission-framed — not clinical or measurement-focused.

## Evidence on Hand

- Working implementation: mic pipeline, Wake Meter, countdown sessions, two mission themes (Dragon, Rocket) with dedicated video/render assets under `assets/video/dragon` etc.
- No testimonials, customer logos, case studies, or usage data exist; do not fabricate any.

## Product Principles

1. The mission's visual consequence is the product — noise should feel like it's doing something dramatic to a world, not moving a meter.
2. Supporting instrumentation (calibration, sensitivity) must stay simple, optional-feeling, and visually secondary to the mission itself.
3. Legibility from across a classroom, at a glance, beats density or nuance in every UI decision during an active mission.
4. Visual tone must span K–7: exciting and playful without reading as preschool-only for older students.
5. Protect scope and privacy: no student data/accounts, no audio storage, no feature creep beyond classroom noise/focus.

## Accessibility & Inclusion

- Large text and critical game states (time remaining, danger level, goal) must be readable from the back of a classroom — this is a product requirement, not a general a11y nicety.
- Standard web accessibility practices apply (per CLAUDE.md: maintain accessibility and responsive layouts); no additional student-specific accommodation requirements have been specified yet.
