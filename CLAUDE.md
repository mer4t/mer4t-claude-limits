# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Two dependency-free (no `npm install`, no `node_modules`) Node.js products that show Claude Code's `/usage` limits (5-hour session + weekly limits) by calling the undocumented `https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1` endpoint with the local Claude Code OAuth token:

1. **Desktop panel** (repo root): `server.js` + `index.html`, packaged into a single executable via Node SEA (`ClaudeLimits.exe` / `ClaudeLimits.app`). Node >= 20.12 (`node:sea` is missing before that; `build.js` refuses older versions).
2. **VS Code extension** (`vscode-extension/`, Marketplace id `mer4t.claude-limits`, VS Code >= 1.82): status bar item + webview panel. Has its own `package.json`, version, and CHANGELOG.

## Commands

Run from the repo root unless noted:
- `npm test`: runs `test/server.test.js` (desktop server) and then `vscode-extension/test/run.js` (extension + `usage.js`). Both are single-file, framework-free runners that use fakes, so they never touch real credentials or the network. There is no per-test filter; run one file directly with `node <file>`, or temporarily edit it to run a single test.
- `npm start`: runs `node server.js` on `http://127.0.0.1:4756` (override with `PORT`). It doesn't open a window when run from source; only the SEA build does. Note that loading the page calls the real API with your real token.
- `npm run build`: `node build.js`. It builds for the **current OS only** (no cross-compilation): `dist/ClaudeLimits.exe` on Windows, `dist/ClaudeLimits.app` on macOS. It uses a pinned `npx postject@…` and, on macOS, `sips`/`iconutil`/`codesign`/`xattr`. SEA needs the official nodejs.org Node; Homebrew Node fails with "Single executable application is disabled". CI (`.github/workflows/ci.yml`) runs the tests and builds both platforms.
- In `vscode-extension/`: `npm test`, and `npm run package` / `npm run publish` (`npx @vscode/vsce`).

## Architecture

**Shared core: `vscode-extension/src/usage.js`** is the single source for reading the token, calling the API and normalizing the response. The extension `require`s it. `server.js` `require`s it from source, and in the SEA build loads it from an embedded asset with `vm` (see `sea-config.json`). Because SEA can only `require` built-in modules, `usage.js` must only use `node:` modules.
- Dependencies are injectable (`platform`, `keychain`, `credPath`, `fetchImpl`). It throws `UsageError` with **codes**, never user-facing text; each product maps codes to its own messages (`errorMessage` in `server.js` in Turkish, in `extension.js` via `vscode.l10n.t`).
- `normalize()` maps either the new `limits[]` array or the legacy `five_hour`/`seven_day`/`seven_day_opus`/`seven_day_sonnet`/`seven_day_oauth_apps` fields to `{kind, percent, resetsAt, level}`. `level` (`normal`/`warning`/`critical`, at 70%/90% or the API's `severity`) is computed only here; every UI just reads it. Invalid dates become `null`.

**Token handling invariants:**
- macOS: the token comes from the Keychain item `Claude Code-credentials` (`/usr/bin/security find-generic-password -w`), with a fallback to the file. Elsewhere it comes from `<CLAUDE_CONFIG_DIR or ~/.claude>/.credentials.json` (`claudeAiOauth.accessToken`).
- The token is **never refreshed or written**, because that would break Claude Code's refresh-token rotation. The file is re-read on every request. The Keychain result is cached for 10 minutes, and the cache is dropped on a 401 or an expired `expiresAt`. A token with an expired `expiresAt` is never sent. After a 401, the request is retried once, and only if the re-read token is different.
- The token must never reach the browser or webview, a URL, or a returned payload. The tests assert this.

**Desktop panel (`server.js`):**
- `createServer()` is exported for tests; `main()` only runs when the file is executed or packaged.
- It is a loopback-only server. Every request must have a `Host` of `127.0.0.1:<port>` or `localhost:<port>`, and a `Sec-Fetch-Site` of `same-origin` or `none`; anything else gets a 403. This blocks DNS rebinding and cross-site requests.
- Routes:
  - `/` serves `index.html` with a per-request CSP nonce injected into its `<script>` and `<style>` tags. That means no inline `style=` attributes and no `innerHTML`; build the DOM instead.
  - `/api/usage` returns `fetchUsage()`'s normalized result. It goes through a 15 s cache that also shares a request already in flight; `?force=1` bypasses the cache.
  - `/api/ping` sends a heartbeat and returns an `X-Claude-Limits: 1` header, which the second-instance check uses.
  - `/api/bye` is the page-close beacon.
- Pages send a `page=<id>` query on every request.
- **Lifecycle (packaged only):**
  - On macOS, startup first kills any orphaned Chrome that uses our profile.
  - It launches Chrome/Edge/Brave/Chromium with `--app` and a private `--user-data-dir` in the temp directory. When that process exits, the server exits — unless it exits within `HANDOFF_MS`, which means it handed the window off to another browser process.
  - The server also shuts down when the last open page sends `/api/bye` (after `BYE_GRACE_MS`, which a reload cancels), or after `IDLE_TICKS` idle checks with no request. That limit counts checks, not wall-clock time, so waking from sleep doesn't trigger it.
  - This also covers the default-browser fallback, used when no Chromium browser is found.
- **Ports:** without `PORT` set, it tries 4756–4765. A port held by our own panel (detected via ping) gets a new window and the process exits; a port held by another app is skipped.
- The console is wrapped because the GUI-subsystem exe has no console attached.
- `index.html` is the whole Turkish UI in one file. It polls every 60 s, skips polling while the page is hidden, polls again right after a limit's `resetsAt`, backs off up to 5 min on errors, allows only one request in flight, and pings every 60 s.
- `build.js` patches the Windows PE `Subsystem` field to GUI directly (no editbin). On macOS it writes an `Info.plist` (with `LSUIElement`), builds an `.icns` from `vscode-extension/media/icon.png`, and ad-hoc signs the bundle.

**VS Code extension (`src/extension.js`):**
- The `Controller` handles polling, the status bar and the webview.
- Polling only runs in the focused window, or while the panel is visible, so multiple VS Code windows don't multiply requests. Nothing is fetched when `showStatusBar` is off and the panel is closed.
- On error, the interval doubles, capped at `max(5 min, interval)`. Every reschedule (setting change, window focus, panel open) goes through `msUntilDue()`, so none of them bypasses the backoff. The last good data stays visible.
- Webview strings like `'{0} left'` are passed through `t()` without arguments on purpose: VS Code leaves `{0}` untouched and `panel.js` fills it in.
- Its color comes from the highest `level`. If the limit that sets the color isn't normally shown, it's appended to the text (e.g. `Opus 95%`).
- Panel listeners are scoped to the panel. A `WebviewPanelSerializer` together with the `onWebviewPanel:` activation event restores the panel after a reload.
- `media/panel.js` and `media/panel.css` are the webview. The webview runs under a strict CSP with a `crypto` nonce and gets data only through `postMessage({type:'state'})`; its strings come from `webviewStrings()`.

## Localization and language conventions

- The desktop panel is **Turkish-only** (UI, server error messages, README, and CHANGELOG).
- The extension uses English source strings with a Turkish translation. When you add a `t('...')` string, add its key to `l10n/bundle.l10n.tr.json`. When you add a manifest string (`%key%`), add it to both `package.nls.json` and `package.nls.tr.json`. Tests fail if either is missing.
- Code comments in both products are Turkish written without diacritics (ASCII). Match this style.
- When you bump a version, update the relevant `package.json`, `CHANGELOG.md` (root changelog in Turkish, extension changelog in English), and the version mentioned in the root README. The server's `User-Agent` reads the version from `package.json`.
