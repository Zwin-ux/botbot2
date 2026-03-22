/**
 * Overlay renderer.
 *
 * Subscribes to the 'decisions' channel (filtered, scored agent outputs) so
 * the overlay only shows things worth acting on — never raw telemetry noise.
 *
 * Raw events (health.change, combat.kill, etc.) are used only to update
 * the status bar values, not to push alerts.
 */

'use strict';

const feed        = document.getElementById('feed');
const connDot     = document.getElementById('conn-dot');
const hpDisplay   = document.getElementById('hp-display');
const credDisplay = document.getElementById('credits-display');

const MAX_ALERTS = 5;

// ── Agent decisions (from /decisions WS channel) ─────────────────────────────
// These are pre-filtered by priority, cooldown, and confidence.
// Each event.payload is a Decision object from decision_engine.js.

window.gp.onGameEvent((event) => {
  connDot.className = 'dot';  // green = live

  if (event.type === 'agent.decision') {
    const d = event.payload;
    pushAlert(d.message, d.priority, d.ttl);
    return;
  }

  // Status bar updates from raw telemetry events (informational only, no alerts)
  switch (event.type) {
    case 'health.change':
      hpDisplay.textContent = `HP ${event.payload.current}/${event.payload.max}`;
      hpDisplay.style.color = hpColor(event.payload.current);
      break;

    case 'economy.credits':
      credDisplay.textContent = `$ ${event.payload.amount}`;
      break;
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function pushAlert(text, priority = 'info', ttl = 6000) {
  // Deduplicate: if an identical message is already showing, refresh its timer
  for (const existing of feed.children) {
    if (existing.dataset.msg === text) {
      resetTtl(existing, ttl);
      return;
    }
  }

  const el = document.createElement('div');
  el.className = `alert ${priorityClass(priority)}`;
  el.textContent = text;
  el.dataset.msg = text;
  feed.prepend(el);

  while (feed.children.length > MAX_ALERTS) {
    feed.removeChild(feed.lastChild);
  }

  resetTtl(el, ttl);
}

function resetTtl(el, ttl) {
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.remove(), ttl);
}

function priorityClass(priority) {
  switch (priority) {
    case 'critical': return 'critical';
    case 'high':     return 'high';
    case 'medium':   return 'warn';
    default:         return '';
  }
}

function hpColor(hp) {
  if (hp <= 25) return '#ef4444';
  if (hp <= 50) return '#f59e0b';
  return '#e8e8e8';
}

connDot.className = 'dot offline';
