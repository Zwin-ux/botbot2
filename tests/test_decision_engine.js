'use strict';

/**
 * DecisionEngine unit tests.
 *
 * Run: node tests/test_decision_engine.js
 *
 * Tests the rule evaluation pipeline:
 *   - condition matching ($lte, $gt, $eq, compound)
 *   - confidence gating (minSignals, window)
 *   - cooldown suppression
 *   - priority ordering
 *   - supersedes (conflict resolution)
 *   - context escalation
 *   - Minesweeper profile rules against realistic events
 */

const path = require('path');

// Stub electron-log (not available outside Electron runtime)
const Module = require('module');
const _origResolve = Module._resolveFilename;
const noop = () => {};
const logStub = { info: noop, warn: noop, error: noop, debug: noop };
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'electron-log') return 'electron-log-stub';
  return _origResolve.call(this, request, parent, isMain, options);
};
require.cache['electron-log-stub'] = {
  id: 'electron-log-stub', filename: 'electron-log-stub', loaded: true,
  exports: logStub,
};

const { DecisionEngine } = require(path.join(__dirname, '../src/services/agent/decision_engine'));

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

function section(title) {
  console.log(`\n${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}`);
}

// ── Mock event factory ──────────────────────────────────────────────────────

function makeEvent(type, payload = {}, ts = Date.now()) {
  return {
    id: `test-${Math.random().toString(36).slice(2, 8)}`,
    type,
    game: 'test',
    ts,
    sessionId: 'test-session',
    payload,
  };
}

// ── SUITE A: Condition matching ─────────────────────────────────────────────

section('SUITE A — Condition matching');

{
  const rules = [
    {
      id: 'low_health',
      trigger: 'health.change',
      condition: { 'payload.current': { $lte: 25 } },
      priority: 'high',
      cooldown: 100,
      confidence: { minSignals: 1, window: 5000 },
      output: { message: 'Low health', ttl: 3000 },
    },
  ];

  const engine = new DecisionEngine(rules);

  // Should NOT match: hp=50 > 25
  const ev1 = makeEvent('health.change', { current: 50, delta: -10 });
  const d1 = engine.evaluate(ev1, []);
  assert(d1.length === 0, 'hp=50 does not trigger $lte 25');

  // Should match: hp=20 <= 25
  const ev2 = makeEvent('health.change', { current: 20, delta: -30 });
  const d2 = engine.evaluate(ev2, []);
  assert(d2.length === 1, 'hp=20 triggers $lte 25');
  assert(d2[0]?.message === 'Low health', 'Correct message output');

  // Should match: hp=25 exactly (lte is inclusive)
  const engine2 = new DecisionEngine(rules);
  const ev3 = makeEvent('health.change', { current: 25, delta: -5 });
  const d3 = engine2.evaluate(ev3, []);
  assert(d3.length === 1, 'hp=25 triggers $lte 25 (inclusive)');
}

// Compound conditions ($gt + $lte)
{
  const rules = [
    {
      id: 'mid_range',
      trigger: 'health.change',
      condition: { 'payload.current': { $gt: 3, $lte: 10 } },
      priority: 'low',
      cooldown: 100,
      confidence: { minSignals: 1, window: 5000 },
      output: { message: 'Mid range', ttl: 3000 },
    },
  ];

  const engine = new DecisionEngine(rules);

  const ev1 = makeEvent('health.change', { current: 5 });
  assert(engine.evaluate(ev1, []).length === 1, 'hp=5 matches compound $gt:3 + $lte:10');

  const engine2 = new DecisionEngine(rules);
  const ev2 = makeEvent('health.change', { current: 2 });
  assert(engine2.evaluate(ev2, []).length === 0, 'hp=2 fails $gt:3');

  const engine3 = new DecisionEngine(rules);
  const ev3 = makeEvent('health.change', { current: 15 });
  assert(engine3.evaluate(ev3, []).length === 0, 'hp=15 fails $lte:10');
}

// $eq operator
{
  const rules = [
    {
      id: 'exact_match',
      trigger: 'round.end',
      condition: { 'payload.winner': { $eq: 'enemy' } },
      priority: 'high',
      cooldown: 100,
      confidence: { minSignals: 1, window: 5000 },
      output: { message: 'You lost', ttl: 3000 },
    },
  ];

  const engine = new DecisionEngine(rules);
  const ev1 = makeEvent('round.end', { winner: 'enemy' });
  assert(engine.evaluate(ev1, []).length === 1, '$eq "enemy" matches');

  const engine2 = new DecisionEngine(rules);
  const ev2 = makeEvent('round.end', { winner: 'self' });
  assert(engine2.evaluate(ev2, []).length === 0, '$eq "enemy" rejects "self"');
}

// ── SUITE B: Confidence gating ──────────────────────────────────────────────

section('SUITE B — Confidence gating (minSignals)');

{
  const rules = [
    {
      id: 'needs_two',
      trigger: 'health.change',
      condition: { 'payload.current': { $lte: 50 } },
      priority: 'medium',
      cooldown: 100,
      confidence: { minSignals: 2, window: 5000 },
      output: { message: 'Confirmed low', ttl: 3000 },
    },
  ];

  const engine = new DecisionEngine(rules);

  // First signal: should NOT fire (1/2)
  const ev1 = makeEvent('health.change', { current: 40 });
  const d1 = engine.evaluate(ev1, []);
  assert(d1.length === 0, 'First signal (1/2) does not fire');

  // Second signal: should fire (2/2)
  const ev2 = makeEvent('health.change', { current: 38 });
  const d2 = engine.evaluate(ev2, []);
  assert(d2.length === 1, 'Second signal (2/2) fires');
}

// ── SUITE C: Cooldown suppression ───────────────────────────────────────────

section('SUITE C — Cooldown suppression');

{
  const rules = [
    {
      id: 'with_cooldown',
      trigger: 'health.change',
      condition: { 'payload.current': { $lte: 50 } },
      priority: 'medium',
      cooldown: 60000,  // 60s cooldown
      confidence: { minSignals: 1, window: 5000 },
      output: { message: 'Cooldown test', ttl: 3000 },
    },
  ];

  const engine = new DecisionEngine(rules);

  // First: fires
  const ev1 = makeEvent('health.change', { current: 30 });
  const d1 = engine.evaluate(ev1, []);
  assert(d1.length === 1, 'First trigger fires');

  // Second immediately after: should be suppressed by cooldown
  const ev2 = makeEvent('health.change', { current: 25 });
  const d2 = engine.evaluate(ev2, []);
  assert(d2.length === 0, 'Second trigger suppressed by cooldown');
}

// ── SUITE D: Wrong trigger type → no match ──────────────────────────────────

section('SUITE D — Trigger type matching');

{
  const rules = [
    {
      id: 'health_only',
      trigger: 'health.change',
      condition: {},
      priority: 'medium',
      cooldown: 100,
      confidence: { minSignals: 1, window: 5000 },
      output: { message: 'Health event', ttl: 3000 },
    },
  ];

  const engine = new DecisionEngine(rules);

  const ev1 = makeEvent('economy.credits', { amount: 3000 });
  assert(engine.evaluate(ev1, []).length === 0, 'economy.credits does not match health.change rule');

  const ev2 = makeEvent('round.start', {});
  assert(engine.evaluate(ev2, []).length === 0, 'round.start does not match health.change rule');
}

// ── SUITE E: Priority ordering ──────────────────────────────────────────────

section('SUITE E — Priority ordering');

{
  const rules = [
    {
      id: 'low_prio',
      trigger: 'health.change',
      condition: { 'payload.current': { $lte: 50 } },
      priority: 'low',
      cooldown: 100,
      confidence: { minSignals: 1, window: 5000 },
      output: { message: 'Low priority', ttl: 3000 },
    },
    {
      id: 'high_prio',
      trigger: 'health.change',
      condition: { 'payload.current': { $lte: 50 } },
      priority: 'high',
      cooldown: 100,
      confidence: { minSignals: 1, window: 5000 },
      output: { message: 'High priority', ttl: 3000 },
    },
  ];

  // Same trigger = same topic ("health") → only highest priority fires
  const engine = new DecisionEngine(rules, { maxDecisionsPerFrame: 2 });

  const ev = makeEvent('health.change', { current: 30 });
  const decisions = engine.evaluate(ev, []);
  assert(decisions.length === 1, 'Same-topic: only 1 decision (highest priority wins)');
  assert(decisions[0].message === 'High priority', 'Higher priority rule selected');
}

// ── SUITE F: Supersedes (conflict resolution) ───────────────────────────────

section('SUITE F — Supersedes (conflict resolution)');

{
  const rules = [
    {
      id: 'critical_hp',
      trigger: 'health.change',
      condition: { 'payload.current': { $lte: 10 } },
      priority: 'critical',
      cooldown: 100,
      confidence: { minSignals: 1, window: 5000 },
      supersedes: ['low_hp'],
      output: { message: 'Critical!', ttl: 5000 },
    },
    {
      id: 'low_hp',
      trigger: 'health.change',
      condition: { 'payload.current': { $lte: 50 } },
      priority: 'medium',
      cooldown: 100,
      confidence: { minSignals: 1, window: 5000 },
      output: { message: 'Low HP', ttl: 3000 },
    },
  ];

  const engine = new DecisionEngine(rules, { maxDecisionsPerFrame: 2 });

  // hp=5 matches BOTH rules, but critical supersedes low_hp
  const ev = makeEvent('health.change', { current: 5 });
  const decisions = engine.evaluate(ev, []);
  assert(decisions.length === 1, 'Only 1 decision (superseded rule removed)');
  assert(decisions[0].message === 'Critical!', 'Critical rule wins');
}

// ── SUITE G: Minesweeper profile rules ──────────────────────────────────────

section('SUITE G — Minesweeper profile rules (real profile)');

{
  const fs = require('fs');
  const profilePath = path.join(__dirname, '../src/profiles/minesweeper/profile.json');
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));

  const engine = new DecisionEngine(profile.rules, {
    maxDecisionsPerFrame: profile.maxDecisionsPerFrame,
  });

  // almost_done: health.change with payload.current <= 3 and > 0
  // needs 2 signals (minSignals: 2)
  const ev1a = makeEvent('health.change', { current: 2, delta: -1 });
  const d1a = engine.evaluate(ev1a, []);
  assert(d1a.length === 0, 'almost_done: 1st signal (1/2) does not fire');

  const ev1b = makeEvent('health.change', { current: 2, delta: -1 });
  const d1b = engine.evaluate(ev1b, []);
  assert(d1b.length === 1, 'almost_done: 2nd signal (2/2) fires');
  assert(d1b[0].message.includes('scan edges'), 'almost_done: correct message');
  assert(d1b[0].priority === 'medium', 'almost_done: priority = medium');

  // game_lost: round.end with payload.winner === "enemy"
  // needs 1 signal (minSignals: 1)
  const engine2 = new DecisionEngine(profile.rules, {
    maxDecisionsPerFrame: profile.maxDecisionsPerFrame,
  });
  const evLost = makeEvent('round.end', { winner: 'enemy', reason: 'end_loss' });
  const dLost = engine2.evaluate(evLost, []);
  assert(dLost.length === 1, 'game_lost fires on round.end + winner=enemy');
  assert(dLost[0].message.includes('Boom'), 'game_lost: correct message');

  // game_won: round.end with payload.winner === "self"
  const engine3 = new DecisionEngine(profile.rules, {
    maxDecisionsPerFrame: profile.maxDecisionsPerFrame,
  });
  const evWon = makeEvent('round.end', { winner: 'self', reason: 'end_win' });
  const dWon = engine3.evaluate(evWon, []);
  assert(dWon.length === 1, 'game_won fires on round.end + winner=self');
  assert(dWon[0].message.includes('Nice sweep'), 'game_won: correct message');

  // taking_long: economy.credits with payload.amount >= 180
  const engine4 = new DecisionEngine(profile.rules, {
    maxDecisionsPerFrame: profile.maxDecisionsPerFrame,
  });
  const ev4a = makeEvent('economy.credits', { amount: 200 });
  engine4.evaluate(ev4a, []);  // 1st signal
  const ev4b = makeEvent('economy.credits', { amount: 210 });
  const d4b = engine4.evaluate(ev4b, []);
  assert(d4b.length === 1, 'taking_long fires after 2 signals with amount >= 180');
  assert(d4b[0].message.includes('number patterns'), 'taking_long: correct message');

  // speed_run: economy.credits with payload.amount <= 30
  const engine5 = new DecisionEngine(profile.rules, {
    maxDecisionsPerFrame: profile.maxDecisionsPerFrame,
  });
  const ev5a = makeEvent('economy.credits', { amount: 20 });
  engine5.evaluate(ev5a, []);  // 1st signal
  const ev5b = makeEvent('economy.credits', { amount: 25 });
  const d5b = engine5.evaluate(ev5b, []);
  assert(d5b.length === 1, 'speed_run fires after 2 signals with amount <= 30');

  // Non-matching: health=50 should NOT trigger almost_done or halfway_done (on fresh engine, needs 2 signals)
  const engine6 = new DecisionEngine(profile.rules, {
    maxDecisionsPerFrame: profile.maxDecisionsPerFrame,
  });
  const evNo = makeEvent('health.change', { current: 50, delta: -10 });
  const dNo = engine6.evaluate(evNo, []);
  assert(dNo.length === 0, 'hp=50 does not match any rule with 1 signal');
}

// ── SUITE H: maxDecisionsPerFrame cap ───────────────────────────────────────

section('SUITE H — maxDecisionsPerFrame cap');

{
  const rules = [
    { id: 'r1', trigger: 'health.change', condition: {}, priority: 'low',    cooldown: 100, confidence: { minSignals: 1, window: 5000 }, output: { message: 'R1', ttl: 3000 } },
    { id: 'r2', trigger: 'health.change', condition: {}, priority: 'medium', cooldown: 100, confidence: { minSignals: 1, window: 5000 }, output: { message: 'R2', ttl: 3000 } },
    { id: 'r3', trigger: 'health.change', condition: {}, priority: 'high',   cooldown: 100, confidence: { minSignals: 1, window: 5000 }, output: { message: 'R3', ttl: 3000 } },
  ];

  const engine = new DecisionEngine(rules, { maxDecisionsPerFrame: 1 });
  const ev = makeEvent('health.change', { current: 50 });
  const decisions = engine.evaluate(ev, []);
  assert(decisions.length === 1, 'Only 1 decision with maxDecisionsPerFrame=1');
  assert(decisions[0].message === 'R3', 'Highest priority rule selected');
}

// ── SUITE I: CS2 profile rules ──────────────────────────────────────────────

section('SUITE I — CS2 profile rules (real profile)');

{
  const fs = require('fs');
  const profilePath = path.join(__dirname, '../src/profiles/cs2/profile.json');
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));

  // health_critical: hp <= 25, supersedes health_low
  const engine1 = new DecisionEngine(profile.rules, { maxDecisionsPerFrame: profile.maxDecisionsPerFrame });
  const ev1a = makeEvent('health.change', { current: 15 });
  engine1.evaluate(ev1a, []);  // 1st signal
  const ev1b = makeEvent('health.change', { current: 15 });
  const d1 = engine1.evaluate(ev1b, []);
  assert(d1.length === 1, 'CS2 health_critical fires after 2 signals');
  assert(d1[0].message.includes('fall back'), 'CS2 health_critical: correct message');
  assert(d1[0].priority === 'critical', 'CS2 health_critical: priority = critical');

  // health_low: 25 < hp <= 50 (should not also fire health_critical at hp=40)
  const engine2 = new DecisionEngine(profile.rules, { maxDecisionsPerFrame: profile.maxDecisionsPerFrame });
  const ev2a = makeEvent('health.change', { current: 40 });
  engine2.evaluate(ev2a, []);
  const ev2b = makeEvent('health.change', { current: 40 });
  const d2 = engine2.evaluate(ev2b, []);
  assert(d2.length === 1, 'CS2 health_low fires at hp=40');
  assert(d2[0].message.includes('passive'), 'CS2 health_low: correct message');

  // eco_round: money <= 1500
  const engine3 = new DecisionEngine(profile.rules, { maxDecisionsPerFrame: profile.maxDecisionsPerFrame });
  const ev3a = makeEvent('economy.credits', { amount: 800 });
  engine3.evaluate(ev3a, []);
  const ev3b = makeEvent('economy.credits', { amount: 800 });
  const d3 = engine3.evaluate(ev3b, []);
  assert(d3.length === 1, 'CS2 eco_round fires at $800');
  assert(d3[0].message.includes('eco'), 'CS2 eco_round: correct message');

  // full_buy: money >= 4750
  const engine4 = new DecisionEngine(profile.rules, { maxDecisionsPerFrame: profile.maxDecisionsPerFrame });
  const ev4a = makeEvent('economy.credits', { amount: 5000 });
  engine4.evaluate(ev4a, []);
  const ev4b = makeEvent('economy.credits', { amount: 5200 });
  const d4 = engine4.evaluate(ev4b, []);
  assert(d4.length === 1, 'CS2 full_buy fires at $5000+');
  assert(d4[0].message.includes('rifle'), 'CS2 full_buy: correct message');

  // round_lost
  const engine5 = new DecisionEngine(profile.rules, { maxDecisionsPerFrame: profile.maxDecisionsPerFrame });
  const evLost = makeEvent('round.end', { winner: 'enemy' });
  const dLost = engine5.evaluate(evLost, []);
  assert(dLost.length === 1, 'CS2 round_lost fires');
  assert(dLost[0].message.includes('economy'), 'CS2 round_lost: correct message');

  // round_won
  const engine6 = new DecisionEngine(profile.rules, { maxDecisionsPerFrame: profile.maxDecisionsPerFrame });
  const evWon = makeEvent('round.end', { winner: 'self' });
  const dWon = engine6.evaluate(evWon, []);
  assert(dWon.length === 1, 'CS2 round_won fires');

  // Supersedes: hp=10 should fire health_critical and suppress health_low
  const engine7 = new DecisionEngine(profile.rules, { maxDecisionsPerFrame: profile.maxDecisionsPerFrame });
  const ev7a = makeEvent('health.change', { current: 10 });
  engine7.evaluate(ev7a, []);
  const ev7b = makeEvent('health.change', { current: 10 });
  const d7 = engine7.evaluate(ev7b, []);
  assert(d7.length === 1, 'CS2 supersedes: only critical fires at hp=10');
  assert(d7[0].ruleId === 'health_critical', 'CS2 supersedes: health_critical wins over health_low');
}

// ── SUITE J: Solitaire profile rules ────────────────────────────────────────

section('SUITE J — Solitaire profile rules (real profile)');

{
  const fs = require('fs');
  const profilePath = path.join(__dirname, '../src/profiles/solitaire/profile.json');
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));

  // high_score: health.change with score >= 500
  const engine1 = new DecisionEngine(profile.rules, { maxDecisionsPerFrame: profile.maxDecisionsPerFrame });
  const ev1a = makeEvent('health.change', { current: 600 });
  engine1.evaluate(ev1a, []);
  const ev1b = makeEvent('health.change', { current: 620 });
  const d1 = engine1.evaluate(ev1b, []);
  assert(d1.length === 1, 'Solitaire high_score fires at 600+');
  assert(d1[0].message.includes('500+'), 'Solitaire high_score: correct message');

  // many_moves: economy.credits with amount >= 100
  const engine2 = new DecisionEngine(profile.rules, { maxDecisionsPerFrame: profile.maxDecisionsPerFrame });
  const ev2a = makeEvent('economy.credits', { amount: 120 });
  engine2.evaluate(ev2a, []);
  const ev2b = makeEvent('economy.credits', { amount: 125 });
  const d2 = engine2.evaluate(ev2b, []);
  assert(d2.length === 1, 'Solitaire many_moves fires at 120');
  assert(d2[0].message.includes('hidden plays'), 'Solitaire many_moves: correct message');

  // game_won: round.end with winner=self
  const engine3 = new DecisionEngine(profile.rules, { maxDecisionsPerFrame: profile.maxDecisionsPerFrame });
  const evWon = makeEvent('round.end', { winner: 'self' });
  const dWon = engine3.evaluate(evWon, []);
  assert(dWon.length === 1, 'Solitaire game_won fires');
  assert(dWon[0].message.includes('GG'), 'Solitaire game_won: correct message');

  // stuck supersedes many_moves: 200+ moves should only fire stuck
  const engine4 = new DecisionEngine(profile.rules, { maxDecisionsPerFrame: profile.maxDecisionsPerFrame });
  const ev4a = makeEvent('economy.credits', { amount: 220 });
  engine4.evaluate(ev4a, []);
  const ev4b = makeEvent('economy.credits', { amount: 225 });
  engine4.evaluate(ev4b, []);
  const ev4c = makeEvent('economy.credits', { amount: 230 });
  const d4 = engine4.evaluate(ev4c, []);
  // stuck needs 3 signals, and should supersede many_moves
  assert(d4.length === 1, 'Solitaire stuck fires after 3 signals at 220+');
  assert(d4[0].ruleId === 'stuck', 'Solitaire stuck supersedes many_moves');

  // score=200 should NOT trigger high_score (needs $gte 500)
  const engine5 = new DecisionEngine(profile.rules, { maxDecisionsPerFrame: profile.maxDecisionsPerFrame });
  const evNo = makeEvent('health.change', { current: 200 });
  const dNo = engine5.evaluate(evNo, []);
  assert(dNo.length === 0, 'Solitaire score=200 does not trigger high_score (1 signal)');
}

// ── Results ─────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Results: ${_passed} passed, ${_failed} failed`);
console.log(`${'═'.repeat(60)}`);
process.exit(_failed > 0 ? 1 : 0);
