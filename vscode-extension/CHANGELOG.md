# Changelog

## Unreleased

- Requires VS Code 1.82 or newer (older versions have no built-in `fetch` in the extension host, so the extension could not work there).
- Error backoff is never shorter than the configured refresh interval, and neither focusing a window nor changing a setting bypasses it (for example after a rate limit).
- With the status bar turned off, reopening the panel shortly after closing it no longer leaves it showing stale data without refreshing.
- The status bar now names a limit that is not normally shown (for example `Opus 95%`) when it is the one driving the warning color, and it respects the API's severity.
- Refreshes right after a limit resets.
- The panel is restored after a window reload.
- macOS: the Keychain is read at most every 10 minutes (or when the token stops working) instead of on every refresh. An expired token no longer triggers an API call; after a 401, a token refreshed by Claude Code is retried once.
- Clearer messages for unexpected API responses and when there is no data yet; "updated" time is shown in minutes/hours.
- Fixed listeners piling up each time the panel was opened and closed.

## 1.0.0

- Initial release.
- Status bar item with current session and weekly usage, colored by severity.
- Detailed panel with live reset countdowns.
- macOS Keychain and Windows/Linux credentials file support.
- English and Turkish localization.
