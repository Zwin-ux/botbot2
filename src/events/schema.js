/**
 * Canonical event schema for GamePartner.
 *
 * Every event flowing through the system must conform to GameEvent.
 * Game-specific parsers (profiles) produce raw readings; the normalizer
 * coerces them into this shape before the agent sees them.
 */

/**
 * @typedef {Object} GameEvent
 * @property {string}  id          - UUID (generated on creation)
 * @property {string}  type        - EVENT_TYPES value
 * @property {string}  game        - e.g. "valorant"
 * @property {number}  ts          - Unix ms timestamp
 * @property {string}  [sessionId] - Current session UUID
 * @property {Object}  payload     - Type-specific data (see below)
 */

const EVENT_TYPES = Object.freeze({
  // Health
  HEALTH_CHANGE:    'health.change',       // { current, max, delta }

  // Economy
  CREDITS_CHANGE:   'economy.credits',     // { amount, delta }
  ROUND_START:      'round.start',         // { roundNumber, phase }
  ROUND_END:        'round.end',           // { roundNumber, winner, reason }
  BUY_PHASE:        'round.buy_phase',     // {}

  // Kill feed
  KILL:             'combat.kill',         // { killer, victim, weapon, headshot }
  DEATH:            'combat.death',        // { killer, weapon }
  ASSIST:           'combat.assist',       // { victim }

  // Ability
  ABILITY_READY:    'ability.ready',       // { slot }   slot: Q|E|C|X
  ABILITY_USED:     'ability.used',        // { slot }
  ULTIMATE_READY:   'ability.ult_ready',   // {}

  // Map
  SPIKE_PLANTED:    'map.spike_planted',   // { site }
  SPIKE_DEFUSED:    'map.spike_defused',   // {}
  SPIKE_DETONATED:  'map.spike_detonated', // {}

  // System
  SESSION_START:    'system.session_start',// { game, profile }
  SESSION_END:      'system.session_end',  // { duration }
  VISION_FRAME:     'system.vision_frame', // { width, height, detections[] }
  SERVICE_STATUS:   'system.service',      // { name, status }

  // Agent outputs
  // Produced by DecisionEngine after priority/cooldown/confidence filtering.
  // The overlay subscribes to these — not raw game events.
  AGENT_DECISION:   'agent.decision',      // Decision (see decision_engine.js)
});

/**
 * Build a validated GameEvent.
 * @param {string} type
 * @param {string} game
 * @param {Object} payload
 * @param {string} [sessionId]
 * @returns {GameEvent}
 */
function createEvent(type, game, payload, sessionId = null) {
  if (!Object.values(EVENT_TYPES).includes(type)) {
    throw new Error(`Unknown event type: ${type}`);
  }
  return {
    id: crypto.randomUUID(),
    type,
    game,
    ts: Date.now(),
    sessionId,
    payload,
  };
}

module.exports = { EVENT_TYPES, createEvent };
