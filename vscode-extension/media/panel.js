(function () {
  const vscode = acquireVsCodeApi();
  const { strings: S, locale } = window.__CLAUDE_LIMITS__;
  const $ = (id) => document.getElementById(id);

  let state = null;

  $('title').textContent = S.title;
  $('statusText').textContent = S.connecting;
  $('emptyMsg').textContent = S.noData;
  $('refreshBtn').textContent = S.refresh;
  $('refreshBtn').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

  function fmt(template, value) {
    return template.replace('{0}', value);
  }

  function fmtAbsolute(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const now = new Date();
    const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return `${S.today} ${time}`;
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    if (d.toDateString() === tomorrow.toDateString()) return `${S.tomorrow} ${time}`;
    return `${d.toLocaleDateString(locale, { day: '2-digit', month: 'short' })} ${time}`;
  }

  function fmtCountdown(iso) {
    if (!iso) return '—';
    const diff = new Date(iso).getTime() - Date.now();
    if (!(diff > 0)) return S.resetting;
    const totalMin = Math.floor(diff / 60000);
    const days = Math.floor(totalMin / 1440);
    const hrs = Math.floor((totalMin % 1440) / 60);
    const min = totalMin % 60;
    const parts = [];
    if (days > 0) parts.push(days + S.unitDay);
    if (days > 0 || hrs > 0) parts.push(hrs + S.unitHour);
    parts.push(min + S.unitMin);
    return fmt(S.left, parts.join(' '));
  }

  function severityClass(pct, severity) {
    if (severity === 'critical' || pct >= 90) return 'red';
    if (severity === 'warning' || pct >= 70) return 'amber';
    return '';
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function render() {
    if (!state) return;
    const pulse = $('pulse');
    const errorBox = $('errorBox');

    if (state.connecting) {
      $('statusText').textContent = S.connecting;
    } else if (state.error) {
      pulse.classList.add('err');
      $('statusText').textContent = S.staleError;
      errorBox.textContent = state.error;
      errorBox.style.display = 'block';
    } else {
      pulse.classList.remove('err');
      $('statusText').textContent = S.live;
      errorBox.style.display = 'none';
    }

    if (state.plan) $('plan').textContent = state.plan;

    const cards = $('cards');
    cards.replaceChildren();
    const limits = state.limits || [];
    $('emptyMsg').hidden = state.connecting || limits.length > 0;

    for (const l of limits) {
      const pct = Math.max(0, Math.min(100, Number(l.percent) || 0));
      const card = el('div', 'card');

      const head = el('div', 'card-head');
      head.append(el('span', 'label', l.label), el('span', 'pct', pct.toFixed(0) + '%'));

      const bar = el('div', 'bar ' + severityClass(pct, l.severity));
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuenow', String(Math.round(pct)));
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      bar.setAttribute('aria-label', l.label);
      const fill = el('i');
      fill.style.width = pct + '%';
      bar.append(fill);

      const abs = fmtAbsolute(l.resetsAt);
      const meta = el('div', 'meta-row');
      const countdown = el('span', 'countdown', fmtCountdown(l.resetsAt));
      countdown.dataset.reset = l.resetsAt || '';
      meta.append(el('span', null, abs ? `${S.resets}: ${abs}` : S.noReset), countdown);

      card.append(head, bar, meta);
      cards.append(card);
    }
    tick();
  }

  function tick() {
    document.querySelectorAll('.countdown').forEach((c) => {
      if (c.dataset.reset) c.textContent = fmtCountdown(c.dataset.reset);
    });
    if (state && state.fetchedAt) {
      const secs = Math.max(0, Math.round((Date.now() - new Date(state.fetchedAt).getTime()) / 1000));
      $('lastUpdated').textContent = fmt(S.updated, secs);
    }
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'state') {
      state = msg;
      $('refreshBtn').disabled = false;
      render();
    } else if (msg.type === 'loading') {
      $('refreshBtn').disabled = true;
    }
  });

  setInterval(tick, 1000);
  vscode.postMessage({ type: 'ready' });
})();
