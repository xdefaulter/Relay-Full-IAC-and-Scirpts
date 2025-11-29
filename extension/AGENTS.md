# Repository Guidelines

Reference this guide whenever you extend or review the Relay Auto browser extension.

## Project Structure & Module Organization
The repository root hosts the active MV3 build: `manifest.json`, the background worker `sw.js`, popup and options UI files, the primary content script `content.js`, and the injected bridge `inpage.js`. `content_old2.js` and `content_ols.js` are frozen baselines—leave them intact for regression diffing. Extensive automation patterns, demos, and archived tests live in `ehdmhmgjjjjjainokogkdokkadmboknm/`, especially within `automation-patterns/` and `freight-automation-extension/`. Add new shared modules beside their main consumers so Chrome’s “Load unpacked” workflow stays simple.

## Build, Test, and Development Commands
```bash
npm install --global web-ext
web-ext run --source-dir . --target=chromium
mkdir -p dist && zip -r dist/relay-auto.zip manifest.json *.js *.html *.css
node ehdmhmgjjjjjainokogkdokkadmboknm/freight-automation-extension/tests/run-all-tests.js
```
`web-ext run` hot-reloads the extension in Chromium, the zip command prepares a releasable artifact, and the Node invocation executes the regression suites while streaming suite stats to stdout. Manual spot-checks should confirm overlay status changes, popup controls, and storage sync behavior after each code change.

## Coding Style & Naming Conventions
Use 2-space indentation, prefer `const`/`let`, and keep identifiers in `camelCase`; reserve SCREAMING_SNAKE_CASE for shared constant bags like `DEFAULTS`. File names describe their role (`sw.js`, `rolling-auth.js`). Keep comments concise and place them above non-obvious logic—mirroring the overlay and network-hint blocks already present in `content.js`.

When running multiple servers side-by-side, configure the “Phase Offset (ms)” and “Start Delay (ms)” fields so each host begins at a common future time (e.g., 3 minutes from now) but still polls on its own phase (server A phase 0, server B phase 200, etc.). The service worker aligns polls to `phase + n * interval` after the start delay, so stagger these values to prevent simultaneous hits.

## Testing Guidelines
Automated suites live in `ehdmhmgjjjjjainokogkdokkadmboknm/freight-automation-extension/tests/` and follow the `*-tests.js` pattern coordinated by `test-runner.js`. Ensure Core, Advanced, Performance, and Integration suites pass via `run-all-tests.js`. When editing polling cadence, selectors, or automation heuristics, add case-specific tests or demo steps under `demo-relay-loadboard/` and document expected overlay badge text plus key log output.

## Commit & Pull Request Guidelines
`CHANGELOG.md` entries use imperative, present-tense statements (“Optimize polling defaults”), so mirror that with scoped commits (`fix: tighten CSRF cache`). PRs must include a short summary, validation steps, linked issues (or “N/A”), and screenshots or timing traces for UI or performance-sensitive work. Keep diffs focused; split large refactors away from behavioral changes.

## Security & Configuration Tips
Do not log CSRF tokens, cookies, or customer identifiers; audit `console.log` before packaging. Host permissions stay confined to `https://relay.amazon.com/*`; justify any expansion in the PR. Persist user settings in `chrome.storage.sync` with explicit min/max gates so aggressive polling cannot trip Relay safeguards.
