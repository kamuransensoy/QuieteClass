# QuietClass

QuietClass is a classroom focus game for teachers and students.

## Product Goal

Teachers choose a mission and a countdown duration.
Classroom microphone noise drives a danger/progress meter.
The class wins if the timer reaches zero before the meter reaches 100%.
The class loses if the meter reaches 100% first.

The product should feel premium, playful, classroom-friendly, highly visual, and easy to understand from a smartboard.

## Development Rules

- The current local workspace is the source of truth.
- Always inspect existing files before editing.
- Edit project files directly in place.
- Do not generate replacement files for me to download.
- Do not recreate files from previous chat context.
- Preserve working behavior unless the task explicitly changes it.
- Do not perform unrelated refactors.
- Keep the architecture lightweight and modular.
- Use Vanilla HTML, CSS, and JavaScript with ES6 modules.
- No frameworks unless explicitly requested.
- No Canvas or WebGL unless explicitly requested.
- Optimize for classroom smartboards, projectors, older laptops, and Chromebooks.
- Avoid unnecessary per-frame DOM updates.
- Prefer CSS transforms/opacity for animation.
- Maintain accessibility and responsive layouts.

## Current Working Systems

The microphone pipeline currently works.
The Wake Meter rises with sustained noise and falls when the room becomes quiet.
Countdown sessions work.
Room calibration and sensitivity are being developed.

Do not retune or rewrite working audio/Wake Meter behavior unless explicitly requested.

## Calibration Architecture

The intended pipeline is:

raw microphone level
→ calibration-derived classifier thresholds
→ noise state
→ Wake Meter
→ active theme

Calibration answers:
"What does this classroom normally sound like?"

Sensitivity answers:
"How tolerant should QuietClass be above that calibrated environment?"

Do not restore the old per-frame baseline subtraction approach.

## Theme Architecture

Theme-specific files must use explicit filenames.

Examples:

dragon_theme.js
dragon_renderer.js

rocket_theme.js
rocket_renderer.js
rocket_scene.js

Future examples:

weather_theme.js
weather_renderer.js
weather_scene.js

Do not create generic theme.js, renderer.js, or scene.js filenames inside theme folders.

## UI Direction

QuietClass setup/product UI:
- light
- colorful
- friendly
- premium
- modern education product
- strong visual hierarchy

Mission worlds may have their own visual style.
For example, Rocket may use a darker cinematic space environment.

Students should understand three things immediately during a mission:

1. Goal
2. Time remaining
3. How close the class is to losing

## Change Safety

Before making changes:
1. Inspect relevant files.
2. Understand the existing data flow.
3. Make the smallest coherent change.
4. Preserve unrelated working systems.

After making changes:
1. Run syntax checks.
2. Verify imports.
3. Search for stale references after renames.
4. Report exactly which files were modified, created, renamed, or deleted.
5. Clearly state anything that could not be browser-tested.

Do not modify anything else in the project during this task.

## Token-Efficient Development Mode

For normal QuietClass development tasks, optimize aggressively for token and tool efficiency.

Unless I explicitly request otherwise:

- Do NOT inspect the entire project.
- Open only files directly relevant to the task.
- Do NOT run browser automation.
- Do NOT launch Edge, Chrome, Playwright, CDP, or headless browsers.
- Do NOT create browser test scripts.
- Do NOT create PowerShell QA frameworks.
- Do NOT take automated screenshots.
- Do NOT run long end-to-end test suites.
- Do NOT wait through real countdown missions for verification.
- Do NOT perform exhaustive grep/search across unrelated files.
- Do NOT investigate unrelated bugs discovered during the task.
- Do NOT refactor unrelated working code.
- Do NOT write long final reports.

I will perform visual and browser QA manually.

After editing:

1. Run `node --check` only on JavaScript files you actually changed, when relevant.
2. Verify only the imports directly affected by your edits.
3. Report exactly which files were modified.
4. Summarize the changes in no more than 5 concise bullets.
5. Mention any obvious item that still needs my manual browser test.
6. Stop.

For small UI tasks, prefer the smallest coherent edit.

For bug fixes, investigate only the code path directly related to the reported bug.

Only perform browser automation or exhaustive verification when I explicitly say:

"Run full automated browser QA."

## Token / Work Discipline

Default to implementation, not investigation.

For routine code edits:
- Do not invoke design skills unless explicitly requested.
- Do not audit before editing.
- Do not read PRODUCT.md unless product direction is changing.
- Read only files explicitly named by the user.
- Do not search the whole project.
- Do not inspect git history.
- Do not browser-test unless requested.
- Do not create tests unless requested.
- Do not explain your plan before editing.
- Do not perform unrelated cleanup or refactors.
- Prefer the smallest possible patch.
- Stop when the requested change is complete.
- Final summaries: maximum 3 bullets.
- If more files are genuinely required, ask before expanding scope.
