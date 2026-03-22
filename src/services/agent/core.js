/**
 * AgentCore — event-driven orchestration.
 *
 * Emits two distinct channels:
 *
 *   'event'    — every canonical GameEvent (health.change, combat.kill, …)
 *                used by storage and debug tooling
 *
 *   'decision' — filtered, scored, deduplicated outputs from DecisionEngine
 *                used by the overlay; never spams
 *
 * Pipeline:
 *   ingest → normalize → [ring] → DecisionEngine → [decision events]
 */

'use strict';

const { EventEmitter } = require('events');
const log = require('electron-log');
const { EventNormalizer } = require('../../events/normalizer');
const { EVENT_TYPES, createEvent } = require('../../events/schema');
const { DecisionEngine } = require('./decision_engine');

const RING_SIZE = 200;

class AgentCore extends EventEmitter {
  constructor() {
    super();
    this.sessionId  = null;
    this.game       = null;
    this.normalizer = null;
    this.profile    = null;
    this.ring       = [];
    this._engine    = null;
    this._startedAt = null;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Called by the HTTP ingest endpoint with raw vision detections.
   */
  ingest(game, sessionId, detections) {
    if (game !== this.game || sessionId !== this.sessionId) {
      this._startSession(game, sessionId);
    }

    const events = this.normalizer.normalize(detections);
    for (const ev of events) {
      this._processEvent(ev);
    }
  }

  /**
   * Inject a pre-formed canonical GameEvent (used by /event HTTP endpoint
   * and for synthetic testing).
   */
  dispatch(event) {
    this._processEvent(event);
  }

  currentSession() {
    return {
      sessionId:  this.sessionId,
      game:       this.game,
      ringSize:   this.ring.length,
      startedAt:  this._startedAt,
    };
  }

  // ── Core pipeline ─────────────────────────────────────────────────────────

  _processEvent(event) {
    // 1. Store in ring
    this._pushRing(event);

    // 2. Broadcast raw event to all listeners (storage, debug WS)
    this.emit('event', event);

    // 3. Skip decision engine for system bookkeeping events
    if (event.type.startsWith('system.') || event.type.startsWith('agent.')) return;

    if (!this._engine) return;

    // 4. Run through decision pipeline
    const decisions = this._engine.evaluate(event, this.ring);

    for (const decision of decisions) {
      const decisionEvent = this._wrapDecision(decision, event);
      this._pushRing(decisionEvent);

      // Broadcast on dedicated 'decision' channel — overlay subscribes here
      this.emit('decision', decisionEvent);

      // Also emit on 'event' so storage captures it
      this.emit('event', decisionEvent);

      log.info(
        `[core] decision: [${decision.priority.toUpperCase()}] ` +
        `"${decision.message}" (conf=${decision.confidence}, rule=${decision.ruleId})`
      );
    }
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────

  _startSession(game, sessionId) {
    if (this.sessionId) {
      this._processEvent(createEvent(EVENT_TYPES.SESSION_END, this.game, {
        duration: Date.now() - (this._startedAt ?? Date.now()),
      }, this.sessionId));
    }

    log.info(`[core] New session: game=${game} sessionId=${sessionId}`);

    this.game       = game;
    this.sessionId  = sessionId;
    this.ring       = [];
    this._startedAt = Date.now();

    // Load game profile
    try {
      // Clear require cache so hot-reloading profile changes works in dev
      const profilePath = require.resolve(`../../profiles/${game}/profile.json`);
      delete require.cache[profilePath];
      this.profile = require(profilePath);
    } catch {
      log.warn(`[core] No profile for "${game}" — running with empty rule set`);
      this.profile = { game, rules: [] };
    }

    this.normalizer = new EventNormalizer(game, this.profile, sessionId);
    this._engine    = new DecisionEngine(this.profile.rules ?? [], {
      maxDecisionsPerFrame: this.profile.maxDecisionsPerFrame ?? 2,
    });

    this._processEvent(createEvent(EVENT_TYPES.SESSION_START, game, {
      game,
      profile: this.profile.name ?? game,
    }, sessionId));
  }

  _pushRing(event) {
    if (this.ring.length >= RING_SIZE) this.ring.shift();
    this.ring.push(event);
  }

  _wrapDecision(decision, sourceEvent) {
    return createEvent(
      EVENT_TYPES.AGENT_DECISION,
      sourceEvent.game,
      decision,
      sourceEvent.sessionId
    );
  }
}

module.exports = { AgentCore };
