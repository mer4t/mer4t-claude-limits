const vscode = require('vscode');
const crypto = require('node:crypto');
const { fetchUsage, UsageError } = require('./usage');

const MIN_INTERVAL_S = 30;
const MAX_BACKOFF_MS = 5 * 60000;
// Limit sifirlandiktan sonra yeni degerin API'ye yansimasi icin kisa bir pay.
const RESET_SLACK_MS = 5000;
const VIEW_TYPE = 'claudeLimits.panel';
const LEVEL_RANK = { normal: 0, warning: 1, critical: 2 };

function t(message, ...args) {
  return vscode.l10n.t(message, ...args);
}

function errorMessage(e) {
  if (!(e instanceof UsageError)) return t('Unexpected error: {0}', String(e && e.message || e));
  const d = e.detail;
  switch (e.code) {
    case 'NO_CREDENTIALS':
      return d.keychain
        ? t('Claude Code credentials not found (Keychain item "{0}" or {1}). Sign in to Claude Code at least once.', d.keychain, d.path)
        : t('Claude Code credentials not found: {0}. Sign in to Claude Code at least once.', d.path);
    case 'BAD_CREDENTIALS':
      return t('Could not read Claude Code credentials (invalid JSON): {0}', d.source);
    case 'NO_TOKEN':
      return t('No session token in Claude Code credentials. Run /login in Claude Code.');
    case 'TIMEOUT':
      return t('Anthropic API timed out, will retry.');
    case 'NETWORK':
      return t('Could not reach the Anthropic API: {0}', d.message || '');
    case 'UNAUTHORIZED':
      return t('The session token seems to have expired. Open Claude Code once so it refreshes its token; this panel will recover automatically.');
    case 'RATE_LIMITED':
      return t('Anthropic is rate limiting requests right now. Will slow down and retry shortly.');
    case 'BAD_RESPONSE':
      return t('Anthropic API returned an unexpected response, will retry.');
    case 'API_ERROR':
      return t('Anthropic API error ({0}): {1}', d.status, d.body || '');
    default:
      return e.code;
  }
}

function limitLabel(kind) {
  switch (kind) {
    case 'session': return t('Current session (5-hour)');
    case 'weekly_all': return t('This week (all models)');
    case 'weekly_opus': return t('This week (Opus)');
    case 'weekly_sonnet': return t('This week (Sonnet)');
    case 'weekly_oauth_apps': return t('This week (connected apps)');
    default: return kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

// Durum cubugundaki kisa ad.
function shortLabel(kind) {
  switch (kind) {
    case 'weekly_opus': return 'Opus';
    case 'weekly_sonnet': return 'Sonnet';
    case 'weekly_oauth_apps': return t('apps');
    default: return limitLabel(kind);
  }
}

function rank(l) {
  return LEVEL_RANK[l && l.level] || 0;
}

function webviewStrings() {
  return {
    title: t('Claude Code usage limits'),
    connecting: t('connecting…'),
    live: t('live'),
    staleError: t('connection error — showing last known data'),
    connectionError: t('connection error'),
    noData: t('No limit data to display.'),
    resets: t('resets'),
    noReset: t('no reset'),
    resetting: t('resetting…'),
    today: t('today'),
    tomorrow: t('tomorrow'),
    left: t('{0} left'),
    unitDay: t('d'),
    unitHour: t('h'),
    unitMin: t('m'),
    unitSec: t('s'),
    updated: t('updated {0} ago'),
    refresh: t('refresh now'),
  };
}

class Controller {
  constructor(context) {
    this.context = context;
    this.latest = null; // { data, error }
    this.timer = null;
    this.inFlight = false;
    this.backoffMs = null;
    this.lastAttempt = 0;
    this.panel = null;
    this.disposed = false;

    this.status = vscode.window.createStatusBarItem('claudeLimits.status', vscode.StatusBarAlignment.Right, 100);
    this.status.name = t('Claude Limits');
    this.status.command = 'claudeLimits.open';
    context.subscriptions.push(this.status);

    context.subscriptions.push(
      vscode.commands.registerCommand('claudeLimits.open', () => this.openPanel()),
      vscode.commands.registerCommand('claudeLimits.refresh', () => this.refreshNow()),
      // Pencere yeniden yuklenince acik panel geri gelsin.
      vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
        deserializeWebviewPanel: async (panel) => this.attachPanel(panel),
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('claudeLimits')) {
          this.renderStatus();
          // Ayar degisikligi hata sonrasi beklemeyi (ornegin 429) bozmasin.
          this.schedule(this.msUntilDue());
        }
      }),
      vscode.window.onDidChangeWindowState((s) => {
        // Arka plandayken sorgu atlaniyor; pencereye donulunce veri eskiyse hemen
        // yenile. Hata sonrasi bekleme (ornegin 429) suruyorsa onu bozmuyoruz.
        if (s.focused && this.msUntilDue() === 0) this.schedule(0);
      }),
      { dispose: () => { this.disposed = true; clearTimeout(this.timer); } }
    );

    this.renderStatus();
    this.schedule(0);
  }

  config() {
    return vscode.workspace.getConfiguration('claudeLimits');
  }

  intervalMs() {
    return Math.max(MIN_INTERVAL_S, Number(this.config().get('refreshInterval')) || 60) * 1000;
  }

  statusBarEnabled() {
    return this.config().get('showStatusBar') !== false;
  }

  // Bir sonraki sorguya kalan sure; hata sonrasi bekleme varsa o esas alinir.
  msUntilDue() {
    return Math.max(0, this.lastAttempt + (this.backoffMs || this.intervalMs()) - Date.now());
  }

  // Durum cubugu kapaliysa ve panel acik degilse API'ye hic istek atilmaz.
  isNeeded() {
    return this.statusBarEnabled() || !!this.panel;
  }

  schedule(delayMs) {
    clearTimeout(this.timer);
    if (this.disposed) return;
    this.timer = setTimeout(() => this.tick(), delayMs);
  }

  // Bir limit bir sonraki yenilemeden once sifirlanacaksa o an yenile.
  nextDelayMs() {
    let delay = this.intervalMs();
    const limits = (this.latest && this.latest.data && this.latest.data.limits) || [];
    const now = Date.now();
    for (const l of limits) {
      const at = l.resetsAt ? new Date(l.resetsAt).getTime() : NaN;
      if (at > now) delay = Math.min(delay, at - now + RESET_SLACK_MS);
    }
    return delay;
  }

  tick() {
    if (!this.isNeeded()) return;
    // Birden fazla VS Code penceresi aciksa hepsi ayni anda sorgu atip rate
    // limite takilmasin: sadece odaktaki pencere (veya gorunen panel) sorgular.
    const visible = this.panel && this.panel.visible;
    if (!vscode.window.state.focused && !visible && this.latest) {
      this.schedule(this.intervalMs());
      return;
    }
    this.poll();
  }

  refreshNow() {
    this.backoffMs = null;
    return this.poll();
  }

  async poll() {
    if (this.inFlight) return;
    this.inFlight = true;
    this.lastAttempt = Date.now();
    this.postToPanel({ type: 'loading' });
    try {
      const data = await fetchUsage({ userAgent: `claude-limits-vscode/${this.context.extension.packageJSON.version}` });
      this.latest = { data, error: null };
      this.backoffMs = null;
    } catch (e) {
      this.latest = { data: this.latest && this.latest.data, error: errorMessage(e) };
      // Tavan, kullanicinin sectigi araliktan kisa olamaz; yoksa hata
      // durumunda normalden sik sorgu atilirdi.
      const cap = Math.max(MAX_BACKOFF_MS, this.intervalMs());
      this.backoffMs = Math.min((this.backoffMs || this.intervalMs()) * 2, cap);
    } finally {
      this.inFlight = false;
    }
    if (this.disposed) return;
    this.renderStatus();
    this.postState();
    this.schedule(this.backoffMs || this.nextDelayMs());
  }

  renderStatus() {
    if (!this.statusBarEnabled()) {
      this.status.hide();
      return;
    }
    const data = this.latest && this.latest.data;
    const error = this.latest && this.latest.error;
    const limits = (data && data.limits) || [];
    const shown = ['session', 'weekly_all'].map((k) => limits.find((l) => l.kind === k)).filter(Boolean);
    const parts = shown.map((l) => `${Math.round(l.percent)}%`);

    // Renk en kritik limitten gelir. O limit durum cubugunda gorunmuyorsa
    // (ornegin Opus) metne de eklenir; yoksa rengin nedeni anlasilmiyordu.
    const worst = limits.reduce((w, l) => (!w || rank(l) > rank(w) ? l : w), null);
    if (worst && rank(worst) > 0 && !shown.includes(worst) && rank(worst) > Math.max(0, ...shown.map(rank))) {
      parts.push(`${shortLabel(worst.kind)} ${Math.round(worst.percent)}%`);
    }

    let text = '✳ ' + (parts.length ? parts.join(' · ') : '—');
    if (error) text = '$(warning) ' + text;
    this.status.text = text;

    const level = worst ? worst.level : 'normal';
    this.status.backgroundColor =
      level === 'critical' ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : level === 'warning' ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;

    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    md.appendMarkdown(`**${t('Claude Code usage limits')}**`);
    if (data && data.subscriptionType) md.appendMarkdown(` — ${escapeMd(String(data.subscriptionType).toUpperCase())}`);
    md.appendMarkdown('\n\n');
    if (!this.latest) md.appendMarkdown(t('connecting…'));
    for (const l of limits) {
      const reset = l.resetsAt ? ` — ${t('resets')} ${formatReset(l.resetsAt)}` : '';
      md.appendMarkdown(`- ${escapeMd(limitLabel(l.kind))}: **${Math.round(l.percent)}%**${escapeMd(reset)}\n`);
    }
    if (error) md.appendMarkdown(`\n\n$(warning) ${escapeMd(error)}`);
    md.appendMarkdown(`\n\n_${t('Click to open the panel')}_`);
    this.status.tooltip = md;
    this.status.show();
  }

  mediaRoot() {
    return vscode.Uri.joinPath(this.context.extensionUri, 'media');
  }

  openPanel() {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, t('Claude Limits'), vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [this.mediaRoot()],
    });
    this.attachPanel(panel);
  }

  // Hem yeni acilan hem de pencere yeniden yuklenince geri getirilen panel icin.
  attachPanel(panel) {
    if (this.panel && this.panel !== panel) this.panel.dispose();
    const mediaRoot = this.mediaRoot();
    panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.png');
    panel.webview.html = this.panelHtml(panel.webview, mediaRoot);
    // Dinleyiciler panelle birlikte atilir; context.subscriptions'a eklenseydi
    // panel her acilip kapandiginda birikirdi.
    const disposables = [
      panel.webview.onDidReceiveMessage((msg) => {
        if (msg && msg.type === 'refresh') this.refreshNow();
        if (msg && msg.type === 'ready') this.postState();
      }),
      panel.onDidChangeViewState(() => {
        if (panel.visible) this.postState();
      }),
    ];
    disposables.push(panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = null;
      for (const d of disposables) d.dispose();
    }));
    this.panel = panel;
    // Durum cubugu kapaliyken polling durmus olabilir; veri tazeyse bile bir
    // sonraki sorgu mutlaka planlanmali.
    if (!this.inFlight) this.schedule(this.msUntilDue());
  }

  postToPanel(msg) {
    if (this.panel) this.panel.webview.postMessage(msg);
  }

  postState() {
    const data = this.latest && this.latest.data;
    this.postToPanel({
      type: 'state',
      error: this.latest ? this.latest.error : null,
      connecting: !this.latest,
      plan: data && data.subscriptionType
        ? String(data.subscriptionType).toUpperCase() + (data.rateLimitTier ? ' · ' + data.rateLimitTier : '')
        : null,
      fetchedAt: data ? data.fetchedAt : null,
      limits: ((data && data.limits) || []).map((l) => ({ ...l, label: limitLabel(l.kind) })),
    });
  }

  panelHtml(webview, mediaRoot) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.js'));
    const init = JSON.stringify({ strings: webviewStrings(), locale: vscode.env.language }).replace(/</g, '\\u003c');
    return `<!doctype html>
<html lang="${escapeHtml(vscode.env.language)}">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="${css}" />
<title>Claude Limits</title>
</head>
<body>
  <div class="window">
    <div class="brand">
      <span class="mark">✳</span>
      <span class="name" id="title"></span>
      <span class="plan" id="plan">—</span>
    </div>
    <div class="status-row">
      <span class="pulse" id="pulse"></span>
      <span id="statusText"></span>
    </div>
    <div class="error-box" id="errorBox" role="alert"></div>
    <div id="cards"></div>
    <div class="empty" id="emptyMsg" hidden></div>
    <div class="footer">
      <span id="lastUpdated">—</span>
      <button id="refreshBtn"></button>
    </div>
  </div>
<script nonce="${nonce}">window.__CLAUDE_LIMITS__ = ${init};</script>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

function formatReset(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(vscode.env.language, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function escapeMd(s) {
  return String(s).replace(/[\\`*_{}[\]()#+\-.!<>|$]/g, '\\$&');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function activate(context) {
  new Controller(context);
}

function deactivate() {}

module.exports = { activate, deactivate };
