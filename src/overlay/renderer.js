'use strict';

/**
 * NES-style overlay renderer.
 *
 * HP bar:    10 segmented blocks, coloured green/orange/red by current HP.
 * Alerts:    step-frame animation, priority sets left-border colour and prefix.
 * Phase bar: thin strip showing current game phase, auto-hides after 12s.
 */

const feed     = document.getElementById('feed');
const conn     = document.getElementById('conn');
const hpTrack  = document.getElementById('hp-track');
const hpNum    = document.getElementById('hp-num');
const credNum  = document.getElementById('cred-num');
const phaseBar = document.getElementById('phase-bar');

const HP_SEGS    = 10;
const MAX_ALERTS = 4;

// ── Build HP bar segments ────────────────────────────────────────────────────

for (let i = 0; i < HP_SEGS; i++) {
  const seg = document.createElement('div');
  seg.className = 'hp-seg';
  hpTrack.appendChild(seg);
}

// ── Connecting placeholder ────────────────────────────────────────────────────
// Show a subtle waiting state until first game event arrives.

let connected = false;

function showConnecting() {
  const el = document.createElement('div');
  el.id        = 'connecting-msg';
  el.className = 'alert info';
  el.innerHTML = '<span class="alert-pfx">   </span>CONNECTING TO GAME...';
  feed.appendChild(el);
  // Blink until first event
  el._blink = setInterval(() => {
    el.style.opacity = el.style.opacity === '0' ? '1' : '0';
  }, 600);
}

function clearConnecting() {
  const el = document.getElementById('connecting-msg');
  if (el) { clearInterval(el._blink); el.remove(); }
}

showConnecting();

// ── Game event handler ────────────────────────────────────────────────────────

window.gp.onGameEvent((event) => {
  if (!connected) { connected = true; clearConnecting(); }
  conn.className = 'live';

  switch (event.type) {

    case 'agent.decision':
      pushAlert(event.payload.message, event.payload.priority, event.payload.ttl);
      break;

    case 'health.change': {
      const hp  = event.payload.current ?? 0;
      const max = event.payload.max || 100;
      setHp(hp, max);
      break;
    }

    case 'economy.credits': {
      const cr = event.payload.amount ?? 0;
      credNum.textContent = cr >= 1000 ? `${(cr / 1000).toFixed(1)}K` : String(cr);
      break;
    }

    case 'round.buy_phase':
      setPhase('BUY PHASE');
      break;

    case 'round.start':
      setPhase('COMBAT');
      break;
  }
});

// ── HP bar (segmented NES-style blocks) ───────────────────────────────────────

function setHp(hp, max) {
  const pct    = Math.max(0, Math.min(1, hp / max));
  const filled = Math.round(pct * HP_SEGS);

  const color = hp > 50
    ? 'var(--green)'
    : hp > 25
      ? 'var(--orange)'
      : 'var(--red)';

  hpTrack.querySelectorAll('.hp-seg').forEach((seg, i) => {
    seg.style.background = i < filled ? color : 'var(--dim)';
  });

  hpNum.textContent = hp;
  hpNum.style.color = hp <= 25
    ? 'var(--red)'
    : hp <= 50
      ? 'var(--orange)'
      : 'var(--gray)';
}

// ── Alert feed ────────────────────────────────────────────────────────────────

const PREFIX = {
  critical: '!!!',
  high:     '!! ',
  medium:   '!  ',
  low:      '\u25B8  ',
  info:     '   ',
};

function pushAlert(text, priority = 'info', ttl = 6000) {
  // Deduplicate: refresh TTL if same message already visible
  for (const el of feed.children) {
    if (el.dataset.msg === text) { resetTtl(el, ttl); return; }
  }

  const cls = ['critical', 'high', 'medium', 'low'].includes(priority)
    ? priority : 'info';

  const el       = document.createElement('div');
  el.className   = `alert ${cls}`;
  el.dataset.msg = text;
  el.innerHTML   = `<span class="alert-pfx">${PREFIX[cls] || '   '}</span>${esc(text).toUpperCase()}`;

  feed.insertBefore(el, feed.firstChild);

  while (feed.children.length > MAX_ALERTS) {
    feed.removeChild(feed.lastChild);
  }

  resetTtl(el, ttl);
}

function resetTtl(el, ttl) {
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.remove(), ttl);
}

// ── Phase bar ────────────────────────────────────────────────────────────────

let phaseTimer = null;

function setPhase(label) {
  phaseBar.textContent = `\u25BA ${label}`;
  phaseBar.classList.add('show');
  clearTimeout(phaseTimer);
  phaseTimer = setTimeout(() => phaseBar.classList.remove('show'), 12000);
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str).replace(/[<>&"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])
  );
}
