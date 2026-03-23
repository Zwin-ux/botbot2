'use strict';

/**
 * Normalizer fixture test.
 *
 * Run: node tests/test_normalizer.js
 *
 * Tests both formats (structured with confidence, flat legacy) across
 * 5 frames that exercise every key normalizer behaviour:
 *
 *   Frame 1 — first readings: baseline set, no events emitted
 *   Frame 2 — health drop within normal bucket (at delta threshold), ability rises
 *   Frame 3 — null health (OCR miss), credits drop, phase 1st confirm (no event yet)
 *   Frame 4 — health crosses LOW bucket, phase 2nd confirm → BUY_PHASE, ability falls
 *   Frame 5 — health crosses CRITICAL bucket, phase null (OCR miss stays silent)
 *
 * Also validates:
 *   - sub-threshold delta within same bucket → no event
 *   - low-confidence reading → no event
 *   - both structured and flat input formats
 *   - duplicate suppression (same phase → no re-emit)
 */

const path = require('path');
const { EventNormalizer } = require(path.join(__dirname, '../src/events/normalizer'));

// ── Assertion helpers ─────────────────────────────────────────────────────────

let _passed = 0;
let _failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓  ${label}`);
    _passed++;
  } else {
    console.error(`  ✗  ${label}`);
    _failed++;
  }
}

function assertEventTypes(events, expectedTypes, label) {
  const actual = events.map(e => e.type);
  const ok = (
    actual.length === expectedTypes.length &&
    expectedTypes.every((t, i) => actual[i] === t)
  );
  if (!ok) {
    console.error(`  ✗  ${label}`);
    console.error(`       expected: [${expectedTypes.join(', ')}]`);
    console.error(`       actual:   [${actual.join(', ')}]`);
    _failed++;
  } else {
    console.log(`  ✓  ${label}`);
    _passed++;
  }
}

function section(title) {
  console.log(`\n${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}`);
}

function printEvents(events, indent = '    ') {
  if (events.length === 0) {
    console.log(`${indent}(no events)`);
    return;
  }
  for (const ev of events) {
    const p = ev.payload;
    const meta = [];
    if (p.current    !== undefined) meta.push(`hp=${p.current}`);
    if (p.delta      !== undefined) meta.push(`Δ=${p.delta > 0 ? '+' : ''}${p.delta}`);
    if (p.bucket     !== undefined) meta.push(`bucket=${p.bucket}`);
    if (p.bucketTransition)         meta.push('BUCKET_CHANGE');
    if (p.amount     !== undefined) meta.push(`credits=${p.amount}`);
    if (p.slot       !== undefined) meta.push(`slot=${p.slot}`);
    if (p.confidence !== undefined) meta.push(`conf=${p.confidence.toFixed(2)}`);
    console.log(`${indent}→ ${ev.type}  { ${meta.join(', ')} }`);
  }
}


// ── Test suite ────────────────────────────────────────────────────────────────

section('SUITE A — Main 5-frame sequence (structured format)');

const norm = new EventNormalizer('valorant', {}, 'session-test-1');

// ── Frame 1: First readings — baselines established, zero events ──────────────
{
  const payload = {
    game: 'valorant',
    timestamp: 1000,
    raw: {
      health:  { value: 87,   confidence: 0.93 },
      credits: { value: 3200, confidence: 0.96 },
      phase:   { value: null, confidence: 0    },   // OCR miss
      abilities: {
        Q: { value: false, confidence: 0.90 },
        E: { value: false, confidence: 0.90 },
        C: { value: false, confidence: 0.90 },
        X: { value: false, confidence: 0.90 },
      },
    },
  };

  const events = norm.normalize(payload);
  console.log('\nFrame 1 — first readings:');
  printEvents(events);

  assertEventTypes(events, [], 'Frame 1: no events on baseline establishment');
  assert(norm._state.health === 87,         'Frame 1: health state = 87');
  assert(norm._state.healthBucket === 'normal', 'Frame 1: bucket = normal');
  assert(norm._state.credits === 3200,      'Frame 1: credits state = 3200');
}

// ── Frame 2: Health drops 5 (at delta=5 threshold) + Q ability rises ─────────
{
  const payload = {
    game: 'valorant',
    timestamp: 1500,
    raw: {
      health:  { value: 82,   confidence: 0.91 },
      credits: { value: 3200, confidence: 0.95 },  // unchanged
      phase:   { value: null, confidence: 0    },
      abilities: {
        Q: { value: true,  confidence: 0.84 },  // Q became ready
        E: { value: false, confidence: 0.88 },
        C: { value: false, confidence: 0.88 },
        X: { value: false, confidence: 0.88 },
      },
    },
  };

  const events = norm.normalize(payload);
  console.log('\nFrame 2 — health -5, Q ability rises:');
  printEvents(events);

  assertEventTypes(events, ['health.change', 'ability.ready'],
    'Frame 2: health.change + ability.ready(Q)');

  const hp = events.find(e => e.type === 'health.change');
  assert(hp?.payload.current === 82,          'Frame 2: health current = 82');
  assert(hp?.payload.delta === -5,            'Frame 2: health delta = -5');
  assert(hp?.payload.bucket === 'normal',     'Frame 2: still in normal bucket');
  assert(hp?.payload.bucketTransition === false, 'Frame 2: no bucket crossing');
  assert(hp?.payload.prevHealth === 87,       'Frame 2: prevHealth = 87');

  const ab = events.find(e => e.type === 'ability.ready');
  assert(ab?.payload.slot === 'Q',            'Frame 2: ability slot = Q');
  assert(norm._state.abilities['Q'] === true, 'Frame 2: Q state updated');
}

// ── Frame 3: null health (OCR miss), credits drop, first phase confirm ────────
{
  const payload = {
    game: 'valorant',
    timestamp: 2000,
    raw: {
      health:  { value: null, confidence: 0    },  // OCR miss this frame
      credits: { value: 2900, confidence: 0.94 },  // dropped 300
      phase:   { value: 'buy', confidence: 0.89 }, // first "buy" reading
      abilities: {
        Q: { value: true, confidence: 0.85 },
        E: { value: false, confidence: 0.88 },
        C: { value: false, confidence: 0.88 },
        X: { value: false, confidence: 0.88 },
      },
    },
  };

  const events = norm.normalize(payload);
  console.log('\nFrame 3 — null health, credits -300, phase "buy" (1st confirm):');
  printEvents(events);

  // Phase needs PHASE_CONFIRM_COUNT=2 consecutive reads — only 1 so far
  assertEventTypes(events, ['economy.credits'],
    'Frame 3: only credits.change (phase not yet confirmed)');

  assert(norm._state.health === 82,   'Frame 3: health state unchanged (null ignored)');
  assert(norm._state.credits === 2900,'Frame 3: credits updated to 2900');
  assert(norm._state.phase === null,  'Frame 3: phase still null (unconfirmed)');

  const cr = events.find(e => e.type === 'economy.credits');
  assert(cr?.payload.amount === 2900,  'Frame 3: credits amount = 2900');
  assert(cr?.payload.delta === -300,   'Frame 3: credits delta = -300');
  assert(cr?.payload.prevCredits === 3200, 'Frame 3: prevCredits = 3200');
}

// ── Frame 4: health crosses LOW bucket, phase confirmed, Q ability falls ──────
{
  const payload = {
    game: 'valorant',
    timestamp: 2500,
    raw: {
      health:  { value: 47, confidence: 0.92 },    // crossed LOW threshold (<=50)
      credits: { value: 2900, confidence: 0.94 },  // unchanged
      phase:   { value: 'buy', confidence: 0.91 }, // second "buy" → confirmed
      abilities: {
        Q: { value: false, confidence: 0.87 },     // Q used
        E: { value: false, confidence: 0.88 },
        C: { value: false, confidence: 0.88 },
        X: { value: false, confidence: 0.88 },
      },
    },
  };

  const events = norm.normalize(payload);
  console.log('\nFrame 4 — health→47 (LOW bucket), buy_phase confirmed, Q used:');
  printEvents(events);

  assertEventTypes(events, ['health.change', 'round.buy_phase', 'ability.used'],
    'Frame 4: health.change + buy_phase + ability.used(Q)');

  const hp = events.find(e => e.type === 'health.change');
  assert(hp?.payload.current === 47,              'Frame 4: health current = 47');
  assert(hp?.payload.bucket === 'low',            'Frame 4: now in low bucket');
  assert(hp?.payload.prevBucket === 'normal',     'Frame 4: prevBucket = normal');
  assert(hp?.payload.bucketTransition === true,   'Frame 4: bucket transition occurred');

  assert(norm._state.phase === 'buy',             'Frame 4: phase committed to "buy"');

  const ab = events.find(e => e.type === 'ability.used');
  assert(ab?.payload.slot === 'Q',                'Frame 4: ability.used slot = Q');
  assert(norm._state.abilities['Q'] === false,    'Frame 4: Q state = false');
}

// ── Frame 5: health sub-threshold within LOW (no event), phase null (silent) ──
{
  const payload = {
    game: 'valorant',
    timestamp: 3000,
    raw: {
      health:  { value: 45, confidence: 0.90 },   // Δ=2, below low-bucket threshold of 3
      credits: { value: 2900, confidence: 0.93 }, // unchanged
      phase:   { value: null, confidence: 0    }, // OCR miss — must stay at "buy"
      abilities: {
        Q: { value: false, confidence: 0.88 },
        E: { value: false, confidence: 0.88 },
        C: { value: false, confidence: 0.88 },
        X: { value: false, confidence: 0.88 },
      },
    },
  };

  const events = norm.normalize(payload);
  console.log('\nFrame 5 — hp 47→45 (sub-threshold), phase null:');
  printEvents(events);

  assertEventTypes(events, [],
    'Frame 5: no events (delta=2 < 3 in low bucket, phase null ignored)');
  assert(norm._state.health === 47,    'Frame 5: health state unchanged (sub-threshold)');
  assert(norm._state.phase === 'buy',  'Frame 5: phase unchanged after OCR miss');
}


// ── SUITE B — Critical bucket crossing ───────────────────────────────────────
section('SUITE B — Health bucket: low → critical');

{
  const norm2 = new EventNormalizer('valorant', {}, 'session-test-2');
  // Seed state: already in low bucket at 28
  norm2._state.health = 28;
  norm2._state.healthBucket = 'low';

  const payload = {
    game: 'valorant',
    timestamp: 4000,
    raw: { health: { value: 12, confidence: 0.88 } },
  };

  const events = norm2.normalize(payload);
  console.log('\nCritical crossing (28 → 12):');
  printEvents(events);

  assertEventTypes(events, ['health.change'], 'Critical crossing: health.change emitted');
  const hp = events[0];
  assert(hp.payload.current === 12,           'Critical crossing: current = 12');
  assert(hp.payload.bucket === 'critical',    'Critical crossing: new bucket = critical');
  assert(hp.payload.prevBucket === 'low',     'Critical crossing: prev bucket = low');
  assert(hp.payload.bucketTransition === true,'Critical crossing: transition flag set');
}


// ── SUITE C — Sub-threshold same bucket: no event ────────────────────────────
section('SUITE C — Sub-threshold within same bucket: no event');

{
  const norm3 = new EventNormalizer('valorant', {}, 'session-test-3');
  norm3._state.health = 48;
  norm3._state.healthBucket = 'low';

  const payload = {
    game: 'valorant',
    timestamp: 5000,
    raw: { health: { value: 46, confidence: 0.91 } },
  };

  const events = norm3.normalize(payload);
  console.log('\nSub-threshold (48 → 46, Δ=2, low bucket min=3):');
  printEvents(events);

  assertEventTypes(events, [],  'Sub-threshold: no event emitted');
  assert(norm3._state.health === 48, 'Sub-threshold: state held at 48');
}


// ── SUITE D — Low confidence gate ────────────────────────────────────────────
section('SUITE D — Low-confidence reading: state preserved');

{
  const norm4 = new EventNormalizer('valorant', {}, 'session-test-4');
  norm4._state.health = 80;
  norm4._state.healthBucket = 'normal';

  const payload = {
    game: 'valorant',
    timestamp: 6000,
    // Confidence 0.25 < MIN_CONFIDENCE (0.40) — should be completely ignored
    raw: { health: { value: 12, confidence: 0.25 } },
  };

  const events = norm4.normalize(payload);
  console.log('\nLow-confidence reading (conf=0.25, value=12):');
  printEvents(events);

  assertEventTypes(events, [],  'Low-confidence: no event despite large value change');
  assert(norm4._state.health === 80, 'Low-confidence: state held at 80');
}


// ── SUITE E — Flat legacy input format ───────────────────────────────────────
section('SUITE E — Flat legacy input (backward compat)');

{
  const norm5 = new EventNormalizer('valorant', {}, 'session-test-5');
  norm5._state.health = 90;
  norm5._state.healthBucket = 'normal';
  norm5._state.credits = 4000;

  // Old flat format — no `raw` wrapper, no confidence scores
  const payload = {
    health:    70,
    healthMax: 100,
    credits:   3500,
    abilities: {
      Q: { ready: true },
      X: { ready: true },
    },
    phase: null,
  };

  const events = norm5.normalize(payload);
  console.log('\nFlat legacy format (health=70, credits=3500, Q+X ready):');
  printEvents(events);

  const types = events.map(e => e.type).sort();
  assert(types.includes('health.change'),     'Legacy: health.change emitted');
  assert(types.includes('economy.credits'),   'Legacy: economy.credits emitted');
  assert(types.includes('ability.ready'),     'Legacy: ability.ready emitted');
  assert(types.includes('ability.ult_ready'), 'Legacy: ability.ult_ready emitted');

  const hp = events.find(e => e.type === 'health.change');
  assert(hp?.payload.current === 70,    'Legacy: health.change current = 70');
  assert(hp?.payload.prevHealth === 90, 'Legacy: health.change prevHealth = 90');
}


// ── SUITE F — Phase confirmation: OCR miss does not reset progress ────────────
section('SUITE F — Phase confirmation buffer');

{
  const norm6 = new EventNormalizer('valorant', {}, 'session-test-6');

  // Frame A: first "combat" reading
  norm6.normalize({
    game: 'valorant', timestamp: 7000,
    raw: { phase: { value: 'combat', confidence: 0.85 }, round_number: { value: 3, confidence: 0.90 } },
  });
  assert(norm6._state.phase === null, 'Phase F-A: not yet confirmed after 1 read');

  // Frame B: OCR miss — must not reset the in-progress confirmation
  norm6.normalize({
    game: 'valorant', timestamp: 7500,
    raw: { phase: { value: null, confidence: 0 } },
  });
  assert(norm6._phaseBuffer.length === 1, 'Phase F-B: null miss does not clear buffer');

  // Frame C: second "combat" reading — should now confirm
  const eventsC = norm6.normalize({
    game: 'valorant', timestamp: 8000,
    raw: { phase: { value: 'combat', confidence: 0.86 }, round_number: { value: 3, confidence: 0.91 } },
  });
  console.log('\nPhase confirmation (combat confirmed after OCR miss):');
  printEvents(eventsC);

  assertEventTypes(eventsC, ['round.start'], 'Phase F-C: round.start emitted on confirmation');
  assert(norm6._state.phase === 'combat',    'Phase F-C: phase state = "combat"');
  assert(eventsC[0]?.payload.roundNumber === 3, 'Phase F-C: roundNumber = 3');

  // Frame D: same phase again — no duplicate event
  const eventsD = norm6.normalize({
    game: 'valorant', timestamp: 8500,
    raw: { phase: { value: 'combat', confidence: 0.89 } },
  });
  assertEventTypes(eventsD, [], 'Phase F-D: no duplicate event for same phase');
}


// ── SUITE G — round.end event ─────────────────────────────────────────────────
{
  console.log(`\n${'─'.repeat(60)}`);
  console.log('  SUITE G — round.end event emission');
  console.log(`${'─'.repeat(60)}`);

  const norm7 = new EventNormalizer('valorant', 'sess-g');

  // Establish combat phase first (2-confirm)
  norm7.normalize({ game: 'valorant', timestamp: 9000, raw: { phase: { value: 'combat', confidence: 0.90 }, round_number: { value: 5, confidence: 0.95 } } });
  norm7.normalize({ game: 'valorant', timestamp: 9500, raw: { phase: { value: 'combat', confidence: 0.90 }, round_number: { value: 5, confidence: 0.95 } } });
  assert(norm7._state.phase === 'combat', 'Suite G setup: phase = combat');

  // First end_win read (1 of 2 needed)
  const evG1 = norm7.normalize({ game: 'valorant', timestamp: 10000, raw: { phase: { value: 'end_win', confidence: 0.85 } } });
  assertEventTypes(evG1, [], 'Phase G-A: round.end not yet emitted after 1 read');

  // Second end_win read — should confirm and emit round.end
  const evG2 = norm7.normalize({ game: 'valorant', timestamp: 10500, raw: { phase: { value: 'end_win', confidence: 0.88 } } });
  console.log('\nRound end (win confirmed):');
  printEvents(evG2);

  assertEventTypes(evG2, ['round.end'], 'Phase G-B: round.end emitted on confirmation');
  assert(norm7._state.phase === 'end_win', 'Phase G-B: phase state = "end_win"');
  assert(evG2[0]?.payload.winner === 'self', 'Phase G-B: winner = self');
  assert(evG2[0]?.payload.reason === 'end_win', 'Phase G-B: reason = end_win');
  assert(evG2[0]?.payload.roundNumber === 5, 'Phase G-B: roundNumber = 5');

  // Verify round.end emitted for end_loss too
  const norm8 = new EventNormalizer('valorant', 'sess-h');
  norm8.normalize({ game: 'valorant', timestamp: 11000, raw: { phase: { value: 'combat', confidence: 0.90 }, round_number: { value: 7, confidence: 0.95 } } });
  norm8.normalize({ game: 'valorant', timestamp: 11500, raw: { phase: { value: 'combat', confidence: 0.90 } } });
  norm8.normalize({ game: 'valorant', timestamp: 12000, raw: { phase: { value: 'end_loss', confidence: 0.82 } } });
  const evH = norm8.normalize({ game: 'valorant', timestamp: 12500, raw: { phase: { value: 'end_loss', confidence: 0.87 } } });
  console.log('\nRound end (loss confirmed):');
  printEvents(evH);

  assertEventTypes(evH, ['round.end'], 'Phase G-C: round.end emitted for end_loss');
  assert(evH[0]?.payload.winner === 'enemy', 'Phase G-C: winner = enemy');
  assert(evH[0]?.payload.reason === 'end_loss', 'Phase G-C: reason = end_loss');
}


// ── Results ───────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`  Results: ${_passed} passed, ${_failed} failed`);
console.log(`${'═'.repeat(60)}\n`);

process.exit(_failed > 0 ? 1 : 0);
