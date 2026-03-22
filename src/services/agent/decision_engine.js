/**
 * DecisionEngine
 *
 * Replaces the naive RuleEngine with a full evaluation pipeline:
 *
 *   match → confidence → context escalation → cooldown → conflict resolution → emit
 *
 * ── Rule schema (profile.json) ────────────────────────────────────────────
 * {
 *   "id":        "health_critical",       // unique, required
 *   "trigger":   "health.change",
 *   "condition": { "payload.current": { "$lte": 25 } },
 *   "priority":  "critical",              // info | low | medium | high | critical
 *   "cooldown":  5000,                    // ms before this rule can fire again
 *   "confidence": {
 *     "minSignals":    2,                 // how many triggers needed before firing
 *     "window":        2000,              // ms window to count signals in
 *     "suppressAfter": 6,                 // suppress if >N signals in window (spam guard)
 *     "suppressWindow": 8000
 *   },
 *   "context": [                          // optional context boosters
 *     { "type": "combat.kill", "within": 4000, "priorityBoost": 1 }
 *   ],
 *   "supersedes": ["health_low"],         // rule IDs to suppress if this rule fires
 *   "output": {
 *     "message": "Critical health — find cover",
 *     "ttl":     6000                     // ms the overlay shows this decision
 *   }
 * }
 */

'use strict';

const log = require('electron-log');

// ── Priority ─────────────────────────────────────────────────────────────────

const PRIORITY = Object.freeze({ info: 0, low: 1, medium: 2, high: 3, critical: 4 });
const PRIORITY_LABEL = ['info', 'low', 'medium', 'high', 'critical'];

function priorityOf(label) {
  return PRIORITY[label] ?? PRIORITY.medium;
}

// ── Condition matcher ─────────────────────────────────────────────────────────
// Operators: $lte $lt $gte $gt $eq $ne $in $nin
// Key paths use dot-notation: "payload.current"

function matchCondition(event, condition) {
  for (const [keyPath, test] of Object.entries(condition)) {
    const value = keyPath.split('.').reduce((o, k) => o?.[k], event);
    if (test !== null && typeof test === 'object' && !Array.isArray(test)) {
      for (const [op, operand] of Object.entries(test)) {
        /* eslint-disable no-fallthrough */
        switch (op) {
          case '$lte': if (!(value <= operand)) return false; break;
          case '$lt':  if (!(value <  operand)) return false; break;
          case '$gte': if (!(value >= operand)) return false; break;
          case '$gt':  if (!(value >  operand)) return false; break;
          case '$eq':  if (value !== operand)   return false; break;
          case '$ne':  if (value === operand)   return false; break;
          case '$in':  if (!operand.includes(value)) return false; break;
          case '$nin': if (operand.includes(value))  return false; break;
        }
      }
    } else {
      if (value !== test) return false;
    }
  }
  return true;
}

// ── Sliding window counter ────────────────────────────────────────────────────

class SignalWindow {
  constructor() {
    this._windows = new Map(); // ruleId → number[]  (timestamps)
  }

  /** Record a signal. Return count of signals still within `windowMs`. */
  record(ruleId, windowMs, now = Date.now()) {
    if (!this._windows.has(ruleId)) this._windows.set(ruleId, []);
    const buf = this._windows.get(ruleId);
    buf.push(now);
    const cutoff = now - windowMs;
    let i = 0;
    while (i < buf.length && buf[i] < cutoff) i++;
    if (i > 0) buf.splice(0, i);
    return buf.length;
  }

  /** Count without recording. */
  count(ruleId, windowMs, now = Date.now()) {
    const buf = this._windows.get(ruleId);
    if (!buf) return 0;
    const cutoff = now - windowMs;
    return buf.filter(t => t >= cutoff).length;
  }

  reset() {
    this._windows.clear();
  }
}

// ── Cooldown tracker ──────────────────────────────────────────────────────────

class CooldownTracker {
  constructor() {
    this._fired = new Map(); // ruleId → lastFiredTs
  }

  isOnCooldown(rule, now = Date.now()) {
    const last = this._fired.get(rule.id);
    if (last === undefined) return false;
    return now - last < (rule.cooldown ?? 4000);
  }

  record(ruleId, now = Date.now()) {
    this._fired.set(ruleId, now);
  }

  reset() {
    this._fired.clear();
  }
}

// ── DecisionEngine ────────────────────────────────────────────────────────────

class DecisionEngine {
  /**
   * @param {Object[]} rules      - compiled from profile.json
   * @param {Object}   [options]
   * @param {number}   [options.maxDecisionsPerFrame=2]
   */
  constructor(rules, options = {}) {
    this._rules    = compileRules(rules);
    this._opts     = {
      maxDecisionsPerFrame: options.maxDecisionsPerFrame ?? 2,
    };
    this._signals  = new SignalWindow();
    this._cooldown = new CooldownTracker();
  }

  /**
   * Main entry. Returns 0-N Decision objects (not yet GameEvents).
   *
   * @param {Object}   event   - canonical GameEvent
   * @param {Object[]} history - event ring (most recent last)
   * @returns {Decision[]}
   */
  evaluate(event, history) {
    const now = Date.now();

    // ── Step 1: Match ──────────────────────────────────────────────────────
    const matched = [];
    for (const rule of this._rules) {
      if (rule.trigger !== event.type) continue;
      if (rule.condition && !matchCondition(event, rule.condition)) continue;
      matched.push(rule);
    }
    if (!matched.length) return [];

    // ── Step 2: Confidence scoring ─────────────────────────────────────────
    // Record the signal and count how many times this rule has fired in its
    // confidence window. A rule needs minSignals before it can produce output.
    const scored = [];
    for (const rule of matched) {
      const cfg    = rule.confidence ?? {};
      const window = cfg.window    ?? 3000;
      const minSig = cfg.minSignals ?? 1;
      const supMax = cfg.suppressAfter  ?? Infinity;
      const supWin = cfg.suppressWindow ?? (window * 2);

      const count = this._signals.record(rule.id, window, now);

      // Not enough signals yet — noise guard
      if (count < minSig) {
        log.debug(`[decision] rule "${rule.id}" below confidence (${count}/${minSig})`);
        continue;
      }

      // Spam guard: too many signals = suppressed (unless critical)
      const spamCount = this._signals.count(rule.id, supWin, now);
      if (spamCount > supMax && priorityOf(rule.priority) < PRIORITY.critical) {
        log.debug(`[decision] rule "${rule.id}" suppressed (spam: ${spamCount}/${supMax})`);
        continue;
      }

      // Confidence score: normalised 0→1, capped at 1
      const rawConfidence = Math.min(count / Math.max(minSig, 1), 1.0);
      scored.push({ rule, confidence: rawConfidence });
    }
    if (!scored.length) return [];

    // ── Step 3: Context escalation ─────────────────────────────────────────
    // Look back in the event ring for correlated signals that increase urgency.
    const escalated = scored.map(({ rule, confidence }) => {
      let priority = priorityOf(rule.priority);

      if (Array.isArray(rule.context)) {
        for (const ctx of rule.context) {
          const cutoff = now - (ctx.within ?? 5000);
          const found  = history.some(h => h.type === ctx.type && h.ts >= cutoff);
          if (found && ctx.priorityBoost) {
            const boosted = priority + ctx.priorityBoost;
            priority = Math.min(PRIORITY.critical, boosted);
            log.debug(`[decision] rule "${rule.id}" escalated by context "${ctx.type}" → ${PRIORITY_LABEL[priority]}`);
          }
        }
      }

      return { rule, confidence, priority };
    });

    // ── Step 4: Cooldown filter ────────────────────────────────────────────
    // Critical priority bypasses cooldown (you always need to know you're dying).
    const active = escalated.filter(({ rule, priority }) => {
      if (priority === PRIORITY.critical) return true;
      if (this._cooldown.isOnCooldown(rule, now)) {
        log.debug(`[decision] rule "${rule.id}" on cooldown`);
        return false;
      }
      return true;
    });
    if (!active.length) return [];

    // ── Step 5: Conflict resolution ────────────────────────────────────────
    const resolved = this._resolve(active, event);
    if (!resolved.length) return [];

    // ── Step 6: Record fires ───────────────────────────────────────────────
    for (const { rule } of resolved) {
      this._cooldown.record(rule.id, now);
    }

    return resolved.map(({ rule, priority, confidence }) =>
      buildDecision(rule, priority, confidence, event)
    );
  }

  /**
   * Reset all cooldowns and signal windows (call on session change).
   */
  resetSession() {
    this._cooldown.reset();
    this._signals.reset();
    log.info('[decision] session reset — cooldowns and signals cleared');
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _resolve(candidates, event) {
    // Topic = first segment of trigger event type (e.g. "health" from "health.change")
    // Within a topic: keep only the highest priority; tie-break by confidence.
    // Cross-topic: sort by priority desc, then cap at maxDecisionsPerFrame.

    // Apply supersedes relationships first — collect suppressed rule IDs
    const suppressed = new Set();
    for (const c of candidates) {
      if (c.priority >= priorityOf(c.rule.priority)) {  // rule fired at >= base priority
        for (const sid of (c.rule.supersedes ?? [])) {
          suppressed.add(sid);
        }
      }
    }

    const filtered = candidates.filter(c => !suppressed.has(c.rule.id));

    // Group by topic
    const byTopic = new Map();
    for (const c of filtered) {
      const topic = c.rule.topic ?? event.type.split('.')[0];
      const existing = byTopic.get(topic);
      const beats =
        !existing ||
        c.priority > existing.priority ||
        (c.priority === existing.priority && c.confidence > existing.confidence);
      if (beats) byTopic.set(topic, c);
    }

    // Sort and cap
    return [...byTopic.values()]
      .sort((a, b) =>
        b.priority !== a.priority
          ? b.priority - a.priority
          : b.confidence - a.confidence
      )
      .slice(0, this._opts.maxDecisionsPerFrame);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Ensure every rule has an ID and normalised fields. */
function compileRules(rules) {
  return rules.map((r, i) => ({
    id:         r.id ?? `rule_${i}`,
    trigger:    r.trigger,
    condition:  r.condition ?? null,
    priority:   r.priority  ?? 'medium',
    cooldown:   r.cooldown  ?? 4000,
    confidence: r.confidence ?? { minSignals: 1, window: 3000 },
    context:    r.context   ?? [],
    supersedes: r.supersedes ?? [],
    topic:      r.topic     ?? null,
    output:     r.output,
  }));
}

/**
 * @typedef {Object} Decision
 * @property {string} ruleId
 * @property {string} message
 * @property {string} priority     - 'info' | 'low' | 'medium' | 'high' | 'critical'
 * @property {number} confidence   - 0.0 → 1.0
 * @property {number} ttl          - ms the overlay should display this
 * @property {string} triggeredBy  - source event ID
 */
function buildDecision(rule, priority, confidence, event) {
  return {
    ruleId:      rule.id,
    message:     rule.output.message,
    priority:    PRIORITY_LABEL[priority],
    confidence:  parseFloat(confidence.toFixed(2)),
    ttl:         rule.output.ttl ?? 6000,
    triggeredBy: event.id,
  };
}

module.exports = { DecisionEngine, matchCondition, PRIORITY, PRIORITY_LABEL };
