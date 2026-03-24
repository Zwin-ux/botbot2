'use strict';

const content = document.getElementById('content');
const loading = document.getElementById('loading');
const footerText = document.getElementById('footer-text');

document.getElementById('btn-close').addEventListener('click', () => window.stats.close());
document.getElementById('btn-min').addEventListener('click',   () => window.stats.minimize());

// ── Helpers ──────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str).replace(/[<>&"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])
  );
}

function ago(tsMs) {
  const diff = Date.now() - tsMs;
  if (diff < 60_000)     return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600_000)   return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000)  return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)  return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// ── Render ───────────────────────────────────────────────────────────────────

async function render() {
  let data;
  try {
    data = await window.stats.getStats();
  } catch (err) {
    loading.textContent = 'FAILED TO LOAD STATS';
    return;
  }

  content.innerHTML = '';

  if (!data || data.totalEvents === 0) {
    content.innerHTML = '<div class="empty">No events recorded yet.<br>Play a game to see stats here.</div>';
    footerText.textContent = 'No data';
    return;
  }

  // ── Overview section ────────────────────────────────────────────────────
  const overview = document.createElement('div');
  overview.innerHTML = `<div class="section-title">Overview</div>`;

  const rows = [
    ['Game',          data.game.toUpperCase(),            ''],
    ['Total Events',  String(data.totalEvents),           'cyan'],
    ['Session Time',  fmtDuration(data.sessionDuration),  'gold'],
    ['Alerts Fired',  String(data.decisions),             'green'],
  ];

  for (const [label, value, cls] of rows) {
    const row = document.createElement('div');
    row.className = 'stat-row';
    row.innerHTML = `<span class="stat-label">${esc(label)}</span>
                     <span class="stat-value ${cls}">${esc(value)}</span>`;
    overview.appendChild(row);
  }
  content.appendChild(overview);

  // ── Event breakdown (bar chart) ─────────────────────────────────────────
  if (data.breakdown && Object.keys(data.breakdown).length > 0) {
    const section = document.createElement('div');
    section.innerHTML = `<div class="section-title" style="margin-top:8px">Event Breakdown</div>`;

    const maxCount = Math.max(1, ...Object.values(data.breakdown));
    const colors = {
      'health.change': 'green',
      'economy.credits': 'gold',
      'round.buy_phase': 'gold',
      'round.start': 'gold',
      'round.end': 'red',
      'ability.ready': 'green',
      'ability.used': 'green',
      'agent.decision': 'green',
    };

    for (const [type, count] of Object.entries(data.breakdown)) {
      const pct = Math.round((count / maxCount) * 100);
      const color = colors[type] || 'green';
      const shortType = type.split('.').pop();

      const bar = document.createElement('div');
      bar.className = 'bar-row';
      bar.innerHTML = `
        <span class="bar-label">${esc(shortType)}</span>
        <div class="bar-track">
          <div class="bar-fill ${color}" style="width:${pct}%"></div>
        </div>
        <span class="bar-num">${count}</span>`;
      section.appendChild(bar);
    }
    content.appendChild(section);
  }

  // ── Recent events ───────────────────────────────────────────────────────
  if (data.recentEvents && data.recentEvents.length > 0) {
    const section = document.createElement('div');
    section.innerHTML = `<div class="section-title" style="margin-top:8px">Recent Events</div>`;

    for (const ev of data.recentEvents.slice(0, 8)) {
      const category = ev.type.split('.')[0];
      const row = document.createElement('div');
      row.className = `event-row ${category}`;

      let detail = '';
      const p = ev.payload;
      if (ev.type === 'health.change')   detail = `HP ${p.current ?? '?'}`;
      if (ev.type === 'economy.credits') detail = `$${p.amount ?? p.credits ?? '?'}`;
      if (ev.type === 'agent.decision')  detail = p.message ? p.message.substring(0, 28) : '';
      if (ev.type === 'round.end')       detail = p.winner === 'self' ? 'WIN' : 'LOSS';
      if (ev.type === 'round.start')     detail = 'ROUND START';
      if (ev.type === 'round.buy_phase') detail = 'BUY PHASE';

      row.innerHTML = `
        <span class="ev-type">${esc(ev.type)}</span>
        <span>${esc(detail)}</span>
        <span class="ev-time">${ago(ev.ts)}</span>`;
      section.appendChild(row);
    }
    content.appendChild(section);
  }

  footerText.textContent = `${data.totalEvents} events \u2022 ${data.game}`;
}

render();
