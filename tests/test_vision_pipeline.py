"""
Vision pipeline tests -- no OpenCV, Tesseract, or screen capture needed.

Uses the synthetic game profile (src/profiles/synthetic/) which encodes game
state as pixel values in a NumPy frame, removing all system dependencies.

Run: python tests/test_vision_pipeline.py
"""

import os
import sys

# Make vision service modules importable
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
sys.path.insert(0, os.path.join(_ROOT, "src", "services", "vision"))
sys.path.insert(0, _HERE)  # for frame_builder

import numpy as np
from detect import FrameDetector
from frame_builder import make_frame, make_meta

# -- Assertion helpers -------------------------------------------------------

_passed = 0
_failed = 0


def ok(condition, label):
    global _passed, _failed
    if condition:
        print(f"  PASS  {label}")
        _passed += 1
    else:
        print(f"  FAIL  {label}", file=sys.stderr)
        _failed += 1


def section(title):
    print(f"\n{'-' * 60}\n  {title}\n{'-' * 60}")


# -- SUITE A: Frame builder round-trip --------------------------------------

section("SUITE A -- Frame builder encodes / detector decodes correctly")

# Import the raw detector directly so we can test it without smoothing
import importlib.util
import json

_det_path = os.path.join(_ROOT, "src", "profiles", "synthetic", "detector.py")
_spec = importlib.util.spec_from_file_location("synthetic_detector", _det_path)
_det_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_det_mod)
raw_detect = _det_mod.detect

_prof_path = os.path.join(_ROOT, "src", "profiles", "synthetic", "profile.json")
with open(_prof_path) as f:
    _profile = json.load(f)


def detect_raw(frame):
    return raw_detect(frame, _profile)


# Health values
for hp in (0, 25, 50, 75, 100):
    r = detect_raw(make_frame(health=hp))
    ok(r["health"] == hp, f"health={hp} encodes/decodes correctly")

# Out-of-range health is filtered
f2 = make_frame(health=100)
f2[10, 10, 0] = 200  # out of range [0,100]
r2 = detect_raw(f2)
ok(r2["health"] is None, "health=200 (out of range) -> None")

# Credits values
for cr in (0, 2400, 3000, 9000):
    r = detect_raw(make_frame(credits=cr))
    ok(r["credits"] == cr, f"credits={cr} encodes/decodes correctly")

# Phase values
for ph in (None, "buy", "combat", "end_win", "end_loss"):
    r = detect_raw(make_frame(phase=ph))
    ok(r["phase"] == ph, f"phase={ph!r} encodes/decodes correctly")

# Round number
for rn in (1, 5, 15, 30):
    r = detect_raw(make_frame(round_number=rn))
    ok(r["round_number"] == rn, f"round_number={rn} encodes/decodes correctly")

# Abilities
abilities_in = {"Q": True, "E": False, "C": True, "X": False}
r = detect_raw(make_frame(abilities=abilities_in))
for slot, expected in abilities_in.items():
    ok(r["abilities"][slot] == expected, f"ability {slot}={expected} encodes/decodes correctly")


# -- SUITE B: FrameDetector smoothing builds confidence over frames ----------

section("SUITE B -- FrameDetector: smoothing builds confidence over frames")

det = FrameDetector("synthetic", capture_res=(640, 480))

# Single frame: fill_ratio=1/5=0.2, below MIN_CONFIDENCE=0.30 for numeric fields
frame1 = make_frame(health=75, credits=3000, phase="combat", round_number=3)
s1 = det.detect(frame1, make_meta(ts_ms=1000))
flat1 = det.to_agent_payload(s1)

ok(s1["raw"]["health"]["value"] == 75, "Frame 1: raw health value = 75")
ok(s1["raw"]["health"]["confidence"] < 0.30,
   f"Frame 1: health confidence ({s1['raw']['health']['confidence']:.2f}) < 0.30 (1 of 5 frames)")
ok(flat1["health"] is None, "Frame 1: health filtered from flat payload (confidence too low)")

# Feed 4 more identical frames: confidence rises, values should pass MIN_CONFIDENCE
for i in range(2, 6):
    s = det.detect(make_frame(health=75, credits=3000, phase="combat", round_number=3),
                   make_meta(ts_ms=1000 * i))

s5 = s
flat5 = det.to_agent_payload(s5)

ok(s5["raw"]["health"]["confidence"] >= 0.30,
   f"Frame 5: health confidence ({s5['raw']['health']['confidence']:.2f}) >= 0.30")
ok(flat5["health"] == 75,    "Frame 5: health=75 passes through flat payload")
ok(flat5["credits"] == 3000, "Frame 5: credits=3000 passes through flat payload")


# -- SUITE C: Phase TextSmoother needs min_votes=2 before committing ---------

section("SUITE C -- Phase TextSmoother: min_votes=2 before emitting")

det2 = FrameDetector("synthetic", capture_res=(640, 480))

# First "buy" frame: TextSmoother needs 2 votes, returns None after 1
s_a = det2.detect(make_frame(phase="buy"), make_meta(ts_ms=1000))
ok(s_a["raw"]["phase"]["value"] is None,
   "Phase A: first 'buy' read -> smoother not yet committed (None)")

# Second "buy" frame: now 2 votes, should commit
s_b = det2.detect(make_frame(phase="buy"), make_meta(ts_ms=1500))
ok(s_b["raw"]["phase"]["value"] == "buy",
   "Phase B: second 'buy' read -> smoother commits to 'buy'")
ok(s_b["raw"]["phase"]["confidence"] >= 0.30,
   f"Phase B: confidence ({s_b['raw']['phase']['confidence']:.2f}) >= 0.30 after commit")


# -- SUITE D: BooleanSmoother needs 3 True reads (window=5, threshold=3) -----

section("SUITE D -- BooleanSmoother: ability requires 3 True reads (window=5, threshold=3)")

det3 = FrameDetector("synthetic", capture_res=(640, 480))

# Seed with not-ready frames so window is pre-filled
for _ in range(3):
    det3.detect(make_frame(abilities={"Q": False, "E": False, "C": False, "X": False}),
                make_meta(ts_ms=1000))

# Two True reads: not enough yet (need 3 of last 5, currently 2 of 5)
det3.detect(make_frame(abilities={"Q": True, "E": False, "C": False, "X": False}),
            make_meta(ts_ms=2000))
s_q2 = det3.detect(make_frame(abilities={"Q": True, "E": False, "C": False, "X": False}),
                   make_meta(ts_ms=2500))
ok(s_q2["raw"]["abilities"]["Q"]["value"] == False,
   "Ability Q: 2 True reads (of 5) -> not yet ready")

# Third True read: now 3 of 5 -> flips to True
s_q3 = det3.detect(make_frame(abilities={"Q": True, "E": False, "C": False, "X": False}),
                   make_meta(ts_ms=3000))
ok(s_q3["raw"]["abilities"]["Q"]["value"] == True,
   "Ability Q: 3 True reads (of 5) -> now ready")


# -- SUITE E: NumericSmoother debounce suppresses sub-threshold jitter -------

section("SUITE E -- NumericSmoother: debounce_delta=3 suppresses small OCR jitter")

det4 = FrameDetector("synthetic", capture_res=(640, 480))

# Stabilise at health=80
for _ in range(5):
    det4.detect(make_frame(health=80), make_meta(ts_ms=1000))

s_stable = det4.detect(make_frame(health=80), make_meta(ts_ms=6000))
ok(s_stable["raw"]["health"]["value"] == 80, "Stable: health=80 after 6 frames")

# Jitter of +1 (delta=1 < debounce_delta=3) -> should hold at 80
s_jitter = det4.detect(make_frame(health=81), make_meta(ts_ms=6500))
ok(s_jitter["raw"]["health"]["value"] == 80,
   "Jitter: health=81 (delta=1 < debounce=3) -> smoother holds at 80")

# Real damage of -10 (delta=10 > 3) -> should update to 70
for _ in range(4):
    det4.detect(make_frame(health=70), make_meta(ts_ms=7000))
s_drop = det4.detect(make_frame(health=70), make_meta(ts_ms=8000))
ok(s_drop["raw"]["health"]["value"] == 70,
   "Real drop: health=70 (delta=10 > debounce=3) -> smoother updates to 70")


# -- SUITE F: reset_session() clears smoother history -----------------------

section("SUITE F -- reset_session() clears smoother history")

det5 = FrameDetector("synthetic", capture_res=(640, 480))
for _ in range(5):
    det5.detect(make_frame(health=90), make_meta(ts_ms=1000))

s_before = det5.detect(make_frame(health=90), make_meta(ts_ms=6000))
ok(s_before["raw"]["health"]["confidence"] >= 0.3,
   "Before reset: health confidence built up")

det5.reset_session()
s_after = det5.detect(make_frame(health=90), make_meta(ts_ms=7000))
ok(s_after["raw"]["health"]["confidence"] < 0.3,
   "After reset: health confidence dropped back to low (1 sample)")
ok(s_after["frame"] == 1, "After reset: frame counter resets to 1")


# -- SUITE G: to_agent_payload produces correct shape -----------------------

section("SUITE G -- to_agent_payload produces correct shape")

det6 = FrameDetector("synthetic", capture_res=(640, 480))
for _ in range(5):
    s = det6.detect(
        make_frame(health=60, credits=2400, phase="buy", round_number=5,
                   abilities={"Q": True, "E": True, "C": False, "X": False}),
        make_meta(ts_ms=1000),
    )
flat = det6.to_agent_payload(s)

ok("health"       in flat, "Payload: 'health' key present")
ok("credits"      in flat, "Payload: 'credits' key present")
ok("phase"        in flat, "Payload: 'phase' key present")
ok("round_number" in flat, "Payload: 'round_number' key present")
ok("abilities"    in flat, "Payload: 'abilities' key present")
ok(flat["healthMax"] == 100, "Payload: healthMax=100")
ok(flat["health"]  == 60,    f"Payload: health=60 (got {flat['health']})")
ok(flat["credits"] == 2400,  f"Payload: credits=2400 (got {flat['credits']})")


# -- Results -----------------------------------------------------------------

print(f"\n{'=' * 60}")
print(f"  Results: {_passed} passed, {_failed} failed")
print(f"{'=' * 60}\n")
sys.exit(1 if _failed > 0 else 0)
