# Claude Limits

See your **Claude Code usage limits** — the 5-hour session limit and the weekly limits — live in the VS Code status bar, without typing `/usage`.

- **Status bar:** `✳ 7% · 6%` shows the current session and weekly (all models) usage. It turns yellow at 70% and red at 90%. Hover for every limit and its reset time.
- **Panel:** click the status bar item (or run **Claude Limits: Show Usage Limits**) for a detailed view with live countdowns to each reset.
- **English and Turkish:** follows your VS Code display language.

## Requirements

You must have signed in to **Claude Code** on this machine at least once. The extension reads the same session token Claude Code uses:

| OS | Where the token is read from |
|---|---|
| macOS | Keychain item `Claude Code-credentials` (falls back to `~/.claude/.credentials.json`) |
| Windows / Linux | `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR/.credentials.json`) |

On macOS, the first read shows a Keychain permission prompt. Choose **Always Allow** so it does not ask again.

## Privacy

- The token is only used to call `https://api.anthropic.com/api/oauth/usage`, the same endpoint Claude Code's `/usage` command uses. It is never sent anywhere else and never reaches the panel's web view.
- The extension never refreshes or writes the token (that could break Claude Code's own token rotation); it re-reads it on every refresh.
- No telemetry. The source code is on [GitHub](https://github.com/mer4t/mer4t-claude-limits/tree/master/vscode-extension).

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeLimits.showStatusBar` | `true` | Show usage in the status bar. When off, nothing is fetched until you open the panel. |
| `claudeLimits.refreshInterval` | `60` | Refresh interval in seconds (minimum 30). Only the focused VS Code window refreshes, so several open windows do not multiply requests. |

## Commands

- **Claude Limits: Show Usage Limits**
- **Claude Limits: Refresh Usage Limits**

## Known limitations

- This uses an undocumented Anthropic endpoint. If Anthropic changes it, the extension may stop working until it is updated.
- The extension runs on your local machine (UI extension). With Remote SSH / WSL / containers, it reads the credentials of the local machine, not the remote one.

## Disclaimer

This is an unofficial community extension. It is not affiliated with, endorsed by, or supported by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.

---

## Türkçe

**Claude Code kullanım limitlerinizi** (5 saatlik oturum ve haftalık limitler) `/usage` yazmadan, VS Code durum çubuğunda canlı görün.

- **Durum çubuğu:** `✳ 7% · 6%` güncel oturum ve haftalık (tüm modeller) kullanımı gösterir; %70'te sarı, %90'da kırmızı olur. Üzerine gelince tüm limitler ve yenilenme saatleri görünür.
- **Panel:** Durum çubuğuna tıklayın (veya **Claude Limits: Kullanım Limitlerini Göster** komutunu çalıştırın); her limit için canlı geri sayımlı ayrıntılı görünüm açılır.
- **Gereksinim:** Bu makinede Claude Code ile en az bir kez giriş yapmış olmalısınız. macOS'ta ilk açılışta Keychain izni istenir, **Her Zaman İzin Ver** seçin.
- **Gizlilik:** Jeton yalnızca `api.anthropic.com`'a gönderilir, başka hiçbir yere gitmez; eklenti jetonu yenilemez veya değiştirmez. Telemetri yoktur.
- Bu, Anthropic ile bağlantısı olmayan, resmi olmayan bir topluluk eklentisidir.
