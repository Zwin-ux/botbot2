'use strict';

/**
 * EventNormalizer
 *
 * Converts raw vision-service detection payloads into canonical GameEvents.
 * Lives in the agent process; one instance per game session.
 *
 * ── Core principle ────────────────────────────────────────────────────────────
 *
 *   "Absent / null / low-confidence reading"  ≠  "value is zero / state changed"
 *
 * The vision service runs at 2 FPS with OCR. Individual frames routinely
 * produce null for a field (text wasn't readable, confidence too low, etc.).
 * The normalizer must:
 *   1. Never overwrite stable state with a null reading.
 *   2. Never emit an event because a reading was absent.
 *   3. Only emit when a real, confident value transition occurs.
 *
 * ── Input formats ─────────────────────────────────────────────────────────────
 *
 * Structured (new vision service):
 *   { raw: { health: { value: 87, confidence: 0.91 }, credits: { value: 3200, confidence: 0.95 }, ... } }
 *
 * Flat (old format / direct injection / tests):
 *   { health: 87, credits: 3200, abilities: { Q: { ready: true } }, ... }
 *
 * Both are supported; structured fields take priority when both are present.
 *
 * ── Pipeline ──────────────────────────────────────────────────────────────────
 *
 *   normalize(payload)
 *     → _extract()          normalise both input formats into FieldMap
 *     → _handleHealth()     bucket-aware delta filtering
 *     → _handleCredits()    material-change filtering
 *     → _handlePhase()      confirmation buffer (N consecutive reads)
 *     → _handleAbilities()  rising-edge READY, falling-edge USED
 *     → _handleSpikeState() transition-only events
 *     → [ ...GameEvent ]
 */

const { EVENT_TYPES, createEvent } = require('./schema');

// ── Tunable constants ─────────────────────────────────────────────────────────

/**
 * Fields with confidence below this are treated as absent.
 * Mirrors MIN_CONFIDENCE in detect.py — but the Python side already filters
 * at 0.30, so anything that arrives here is already >= 0.30. We set a slightly
 * higher bar on the JS side as a second guard.
 */
const MIN_CONFIDENCE = 0.40;

/**
 * Health bucket boundaries (inclusive: a value AT the boundary is in the lower bucket).
 *   NORMAL   > LOW_MAX
 *   LOW      > CRITICAL_MAX && <= LOW_MAX
 *   CRITICAL <= CRITICAL_MAX
 */
const HP_BUCKET = Object.freeze({ LOW: 50, CRITICAL: 25 });

/**
 * Minimum |delta| required to emit a health.change within the *same* bucket.
 * Bucket-crossing events are ALWAYS emitted regardless of delta magnitude.
 *
 * Rationale: small HP fluctuations in the normal range are background noise
 * (chip damage, OCR rounding). In critical range, every HP point matters.
 */
const HP_DELTA_MIN = Object.freeze({ normal: 5, low: 3, critical: 2 });

/**
 * Minimum |delta| required to emit an economy.credits event.
 * Ignores sub-50 rounding artifacts from credits OCR.
 */
const CREDITS_DELTA_MIN = 50;

/**
 * Number of consecutive *non-null* identical phase readings required before
 * committing to a phase transition.
 *
 * Why 2: The Python TextSmoother already requires min_votes=2, so readings
 * arriving here are pre-filtered. One extra confirmation in JS guards against
 * the edge case where the Python smoother flips on exactly 2 readings out of
 * a window that includes a round transition.
 */
const PHASE_CONFIRM_COUNT = 2;


// ── Field extraction helpers ──────────────────────────────────────────────────

/**
 * @typedef {{ value: *, confidence: number, present: boolean }} FieldReading
 * present=false means "not in this payload at all" (different from value=null)
 */

/**
 * Extract a single field from a source object, accepting both formats:
 *   structured: { value: V, confidence: C }
 *   flat:       V  (treated as confidence=1.0)
 *
 * Returns a FieldReading where `present` is false only when none of the
 * candidate keys are found in `source`.
 *
 * @param {Object}   source     - object to look in
 * @param {string[]} keys       - candidate key names to try (first match wins)
 * @returns {FieldReading}
 */
function extractField(source, keys) {
  for (const key of keys) {
    if (!(key in source)) continue;

    const raw = source[key];

    // null in either format → reading present but unreadable
    if (raw === null || raw === undefined) {
      return { value: null, confidence: 0, present: true };
    }

    // Structured format: { value: V, confidence: C }
    if (typeof raw === 'object' && 'value' in raw) {
      return {
        value:      raw.value ?? null,
        confidence: raw.confidence ?? 1.0,
        present:    true,
      };
    }

    // Flat format: the raw IS the value
    return { value: raw, confidence: 1.0, present: true };
  }

  return { value: null, confidence: 0, present: false };
}

/**
 * Normalise the full payload into a flat FieldMap, trying all known name
 * variants. Supports structured (nested under `raw`) and flat layouts.
 *
 * @param {Object} payload
 * @returns {Object.<string, FieldReading>}
 */
function extractAll(payload) {
  // The Python service wraps everything under `raw`; older code sends flat.
  // We merge both so a caller can mix structured and flat fields.
  const flat       = payload;
  const structured = payload.raw ?? {};

  /**
   * Try structured first (has explicit confidence), fall back to flat.
   * `keys` lists all naming variants for the same logical field
   * (Python uses snake_case, old JS used camelCase).
   */
  function field(keys) {
    const fromStructured = extractField(structured, keys);
    if (fromStructured.present) return fromStructured;
    return extractField(flat, keys);
  }

  return {
    health:      field(['health']),
    credits:     field(['credits']),
    phase:       field(['phase']),
    roundNumber: field(['roundNumber', 'round_number']),
    spikeState:  field(['spikeState', 'spike_state']),
    // abilities handled separately — they are always a sub-object
    abilities:   extractAbilities(flat, structured),
  };
}

/**
 * Extract the abilities sub-map. Supports:
 *   { abilities: { Q: { ready: true } } }             (old flat)
 *   { abilities: { Q: { value: true, confidence: 0.8 } } }  (structured nested)
 *   { ultimate_ready: { value: true, confidence: 0.8 } }    (structured flat)
 */
function extractAbilities(flat, structured) {
  const result = {};

  // Nested abilities object (both old and new formats)
  const abSrc = structured.abilities ?? flat.abilities ?? {};
  for (const [slot, data] of Object.entries(abSrc)) {
    if (data === null || data === undefined) {
      result[slot] = { value: false, confidence: 0, present: true };
    } else if (typeof data === 'object' && 'value' in data) {
      result[slot] = { value: !!data.value, confidence: data.confidence ?? 1.0, present: true };
    } else if (typeof data === 'object' && 'ready' in data) {
      result[slot] = { value: !!data.ready, confidence: 1.0, present: true };
    } else {
      result[slot] = { value: !!data, confidence: 1.0, present: true };
    }
  }

  // Structured flat keys: ultimate_ready, ability_Q_ready, etc.
  const ultReady = extractField(structured, ['ultimate_ready']);
  if (ultReady.present) result['X'] = { ...ultReady, value: !!ultReady.value };

  for (const slot of ['Q', 'E', 'C']) {
    const key = `ability_${slot.toLowerCase()}_ready`;
    const r = extractField(structured, [key]);
    if (r.present) result[slot] = { ...r, value: !!r.value };
  }

  return result;
}


// ── Health bucket helpers ─────────────────────────────────────────────────────

function getHealthBucket(hp) {
  if (hp <= HP_BUCKET.CRITICAL) return 'critical';
  if (hp <= HP_BUCKET.LOW)      return 'low';
  return 'normal';
}

function hpDeltaMin(bucket) {
  return HP_DELTA_MIN[bucket] ?? 5;
}


// ── EventNormalizer class ─────────────────────────────────────────────────────

class EventNormalizer {
  /**
   * @param {string} game       - e.g. "valorant"
   * @param {Object} profile    - loaded game profile (unused today, reserved for overrides)
   * @param {string} sessionId
   */
  constructor(game, profile, sessionId) {
    this.game      = game;
    this.profile   = profile;
    this.sessionId = sessionId;

    // ── Stable state (only written when we have a real reading) ───────────────
    // Rule: a field is null until we receive a first confident reading.
    //       Once set, it is never overwritten by null or low-confidence data.
    this._state = {
      health:        null,   // last confirmed HP value (integer)
      healthBucket:  null,   // 'normal' | 'low' | 'critical'
      credits:       null,   // last confirmed credits
      phase:         null,   // last *confirmed* phase (after buffer check)
      roundNumber:   null,
      spikeState:    null,
      abilities:     {},     // slot → bool (last known ready state)
    };

    // ── Phase confirmation buffer ─────────────────────────────────────────────
    // Only non-null phase readings are pushed here. When the last
    // PHASE_CONFIRM_COUNT entries are all identical we commit to that phase.
    this._phaseBuffer = [];  // ring of last PHASE_CONFIRM_COUNT readings
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Process one detection frame. Returns 0–N canonical GameEvents.
   * Called by AgentCore.ingest() for every frame from the vision service.
   *
   * @param {Object} payload  - raw payload from vision service (either format)
   * @returns {GameEvent[]}
   */
  normalize(payload) {
    const fields = extractAll(payload);
    const ts     = payload.timestamp ?? Date.now();
    const events = [];

    // Each handler returns 0-N events. They mutate this._state on success.
    events.push(...this._handleHealth(fields.health, ts));
    events.push(...this._handleCredits(fields.credits, ts));
    events.push(...this._handlePhase(fields.phase, fields.roundNumber, ts));
    events.push(...this._handleAbilities(fields.abilities, ts));
    events.push(...this._handleSpikeState(fields.spikeState, ts));

    return events;
  }

  /**
   * Reset state when the game session changes.
   * Called by AgentCore when game or sessionId changes.
   */
  resetSession(sessionId) {
    this.sessionId    = sessionId;
    this._state       = {
      health: null, healthBucket: null, credits: null,
      phase: null, roundNumber: null, spikeState: null, abilities: {},
    };
    this._phaseBuffer = [];
  }

  // ── Field handlers ────────────────────────────────────────────────────────────

  /**
   * Health handler.
   *
   * Emits health.change only when:
   *   (a) we have a confident reading (>= MIN_CONFIDENCE)
   *   (b) the value has actually changed from the last confirmed reading
   *   (c) either the bucket changed, OR the delta exceeds the per-bucket minimum
   *
   * The bucket-change gate is the key anti-spam measure:
   *   - 62 → 48: bucket normal→low  → EMIT (always emit on bucket crossing)
   *   - 48 → 46: both low, delta=2 < 3 → SUPPRESS
   *   - 48 → 45: both low, delta=3 >= 3 → EMIT
   *   - 28 → 12: bucket low→critical  → EMIT
   */
  _handleHealth(reading, ts) {
    // ── Gate 1: absent or unreadable ─────────────────────────────────────────
    // "Not in payload" and "value is null" are both treated as "no reading".
    // Neither can change state or produce an event.
    if (!reading.present || reading.value === null) return [];
    if (reading.confidence < MIN_CONFIDENCE) return [];

    const current = reading.value;
    const prev    = this._state.health;

    // ── Gate 2: first reading — establish baseline silently ───────────────────
    // We have no previous value to diff against. Set state and return.
    // Not emitting here prevents a flood of spurious events at session start.
    if (prev === null) {
      this._state.health       = current;
      this._state.healthBucket = getHealthBucket(current);
      return [];
    }

    const delta         = current - prev;
    const currentBucket = getHealthBucket(current);
    const prevBucket    = this._state.healthBucket;
    const bucketChanged = currentBucket !== prevBucket;

    // ── Gate 3: meaningful change check ──────────────────────────────────────
    // Within the same bucket, only emit if the delta clears the per-bucket minimum.
    // Bucket crossings are always meaningful regardless of delta magnitude.
    if (!bucketChanged && Math.abs(delta) < hpDeltaMin(currentBucket)) {
      // Delta too small — likely OCR rounding or chip damage not worth surfacing.
      // Do NOT update state so future frames diff against the last real value.
      return [];
    }

    // ── Commit ────────────────────────────────────────────────────────────────
    this._state.health       = current;
    this._state.healthBucket = currentBucket;

    return [createEvent(EVENT_TYPES.HEALTH_CHANGE, this.game, {
      current,
      max:              100,
      delta,
      prevHealth:       prev,
      bucket:           currentBucket,
      prevBucket,
      bucketTransition: bucketChanged,
      confidence:       reading.confidence,
      source:           'health',
    }, this.sessionId)];
  }

  /**
   * Credits handler.
   *
   * Emits economy.credits only when the change >= CREDITS_DELTA_MIN.
   * Small fluctuations (< 50 credits) are OCR noise from digit misreads.
   */
  _handleCredits(reading, ts) {
    if (!reading.present || reading.value === null) return [];
    if (reading.confidence < MIN_CONFIDENCE) return [];

    const amount = reading.value;
    const prev   = this._state.credits;

    if (prev === null) {
      this._state.credits = amount;
      return [];
    }

    const delta = amount - prev;
    if (Math.abs(delta) < CREDITS_DELTA_MIN) return [];

    this._state.credits = amount;

    return [createEvent(EVENT_TYPES.CREDITS_CHANGE, this.game, {
      amount,
      delta,
      prevCredits: prev,
      confidence:  reading.confidence,
      source:      'credits',
    }, this.sessionId)];
  }

  /**
   * Phase handler with confirmation buffer.
   *
   * The OCR phase reading can flicker during round transitions
   * (the screen briefly shows the previous phase or nothing).
   *
   * Strategy:
   *   - Only push *non-null* readings into the buffer.
   *   - When the last PHASE_CONFIRM_COUNT readings all agree on a new phase,
   *     commit and emit.
   *   - A null reading is silently ignored — it does not reset the buffer,
   *     and it cannot reverse a committed phase.
   *
   * This means: one OCR miss (null) mid-transition will not delay confirmation.
   * Two consecutive different-phase reads are required to actually change state.
   */
  _handlePhase(phaseReading, roundReading, ts) {
    const events = [];

    if (!phaseReading.present || phaseReading.value === null) {
      // No reading this frame — leave buffer and committed phase intact.
      return [];
    }
    if (phaseReading.confidence < MIN_CONFIDENCE) return [];

    const incomingPhase = phaseReading.value.toLowerCase().trim();

    // Push into buffer, keep last PHASE_CONFIRM_COUNT entries
    this._phaseBuffer.push(incomingPhase);
    if (this._phaseBuffer.length > PHASE_CONFIRM_COUNT) {
      this._phaseBuffer.shift();
    }

    // Not enough readings yet to confirm
    if (this._phaseBuffer.length < PHASE_CONFIRM_COUNT) return [];

    // Check whether all buffered readings agree
    const allSame = this._phaseBuffer.every(p => p === this._phaseBuffer[0]);
    if (!allSame) return [];

    const confirmedPhase = this._phaseBuffer[0];

    // Already in this phase — no transition event needed
    if (confirmedPhase === this._state.phase) return [];

    // ── Commit phase transition ───────────────────────────────────────────────
    const prevPhase = this._state.phase;
    this._state.phase = confirmedPhase;

    if (confirmedPhase === 'buy') {
      // Capture credits from state for buy-phase context
      events.push(createEvent(EVENT_TYPES.BUY_PHASE, this.game, {
        prevPhase,
        credits:    this._state.credits,
        confidence: phaseReading.confidence,
        source:     'phase',
      }, this.sessionId));
    }

    if (confirmedPhase === 'combat' || confirmedPhase.startsWith('combat')) {
      // Round number is optional — may not be readable every frame
      const roundNum = this._getRoundNumber(roundReading);
      if (roundNum !== null) this._state.roundNumber = roundNum;

      events.push(createEvent(EVENT_TYPES.ROUND_START, this.game, {
        roundNumber: this._state.roundNumber,
        prevPhase,
        phase:      confirmedPhase,
        confidence: phaseReading.confidence,
        source:     'phase',
      }, this.sessionId));
    }

    if (confirmedPhase === 'end_win' || confirmedPhase === 'end_loss') {
      // Round ended — emit round.end with outcome and last known round number
      const roundNum = this._getRoundNumber(roundReading);
      if (roundNum !== null) this._state.roundNumber = roundNum;

      events.push(createEvent(EVENT_TYPES.ROUND_END, this.game, {
        roundNumber: this._state.roundNumber,
        winner:     confirmedPhase === 'end_win' ? 'self' : 'enemy',
        reason:     confirmedPhase,
        prevPhase,
        confidence: phaseReading.confidence,
        source:     'phase',
      }, this.sessionId));
    }

    return events;
  }

  /**
   * Ability handler.
   *
   * Emits ABILITY_READY on the rising edge (false → true) per slot.
   * Emits ABILITY_USED on the falling edge (true → false) per slot.
   * Slot 'X' always emits ULTIMATE_READY / ABILITY_USED (ult slot is special).
   *
   * Null readings for a slot are skipped — we never force an ability to
   * "not ready" based on a missing reading. The ability stays in whatever
   * state it was last confirmed in.
   */
  _handleAbilities(abilitiesMap, ts) {
    const events = [];

    for (const [slot, reading] of Object.entries(abilitiesMap)) {
      if (!reading.present || reading.value === null) continue;
      if (reading.confidence < MIN_CONFIDENCE) continue;

      const isReady = reading.value;
      const wasReady = this._state.abilities[slot] ?? false;

      if (isReady === wasReady) continue;  // no change

      this._state.abilities[slot] = isReady;

      if (isReady) {
        // Rising edge — ability became available
        events.push(createEvent(
          slot === 'X' ? EVENT_TYPES.ULTIMATE_READY : EVENT_TYPES.ABILITY_READY,
          this.game,
          { slot, confidence: reading.confidence, source: 'abilities' },
          this.sessionId
        ));
      } else {
        // Falling edge — ability was used (or recharging)
        events.push(createEvent(EVENT_TYPES.ABILITY_USED, this.game, {
          slot,
          confidence: reading.confidence,
          source:     'abilities',
        }, this.sessionId));
      }
    }

    return events;
  }

  /**
   * Spike-state handler.
   *
   * Emits on any confirmed state transition.
   * A null reading never resets spike state (the spike doesn't un-plant itself).
   */
  _handleSpikeState(reading, ts) {
    if (!reading.present || reading.value === null) return [];
    if (reading.confidence < MIN_CONFIDENCE) return [];

    const state = reading.value.toLowerCase();
    if (state === this._state.spikeState) return [];

    const prevState = this._state.spikeState;
    this._state.spikeState = state;

    const typeMap = {
      planted:   EVENT_TYPES.SPIKE_PLANTED,
      defused:   EVENT_TYPES.SPIKE_DEFUSED,
      detonated: EVENT_TYPES.SPIKE_DETONATED,
    };

    const type = typeMap[state];
    if (!type) return [];

    return [createEvent(type, this.game, {
      prevState,
      confidence: reading.confidence,
      source:     'spike_state',
    }, this.sessionId)];
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  _getRoundNumber(reading) {
    if (!reading || !reading.present || reading.value === null) return null;
    if (reading.confidence < MIN_CONFIDENCE) return null;
    return reading.value;
  }
}

module.exports = { EventNormalizer };
