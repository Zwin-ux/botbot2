"""
Minesweeper detector tests — validates difficulty-aware ROI auto-detection.

No OpenCV, Tesseract, or screen capture needed. Tests only the ROI
computation logic (_rois_for_frame), not OCR accuracy.

Run: python tests/test_minesweeper_detector.py
"""

import os
import sys
import json

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)

# Make Minesweeper detector importable
sys.path.insert(0, os.path.join(_ROOT, "src", "profiles", "minesweeper"))
sys.path.insert(0, os.path.join(_ROOT, "src", "services", "vision"))

import numpy as np

# Import the ROI computation function directly
import importlib.util
_det_path = os.path.join(_ROOT, "src", "profiles", "minesweeper", "detector.py")
_spec = importlib.util.spec_from_file_location("ms_detector", _det_path)
_det_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_det_mod)
_rois_for_frame = _det_mod._rois_for_frame

# Load the real profile
_prof_path = os.path.join(_ROOT, "src", "profiles", "minesweeper", "profile.json")
with open(_prof_path) as f:
    _profile = json.load(f)

_hud = _profile["hud"]


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


# -- SUITE A: ROI computation for different window widths --------------------

section("SUITE A -- Dynamic ROI computation per difficulty")

# Expert board window: ~488px wide
expert_frame = np.zeros((346, 488, 3), dtype=np.uint8)
expert_rois = _rois_for_frame(expert_frame, _hud)

ok(expert_rois["health"]["roi"][0] == 17, "Expert: mine counter x=17")
ok(expert_rois["health"]["roi"][1] == 56, "Expert: mine counter y=56")
ok(expert_rois["health"]["roi"][2] == 41, "Expert: mine counter w=41")

# Timer should be at right edge minus padding minus LCD width
expected_timer_x = 488 - 17 - 41  # 430
ok(expert_rois["credits"]["roi"][0] == expected_timer_x,
   f"Expert: timer x={expected_timer_x} (got {expert_rois['credits']['roi'][0]})")

# Face should be centred
expected_face_x = (488 // 2) - (26 // 2)  # 231
ok(expert_rois["phase"]["roi"][0] == expected_face_x,
   f"Expert: face x={expected_face_x} (got {expert_rois['phase']['roi'][0]})")


# Intermediate board window: ~304px wide
inter_frame = np.zeros((346, 304, 3), dtype=np.uint8)
inter_rois = _rois_for_frame(inter_frame, _hud)

ok(inter_rois["health"]["roi"][0] == 17, "Intermediate: mine counter x=17 (same)")
expected_timer_x_i = 304 - 17 - 41  # 246
ok(inter_rois["credits"]["roi"][0] == expected_timer_x_i,
   f"Intermediate: timer x={expected_timer_x_i} (got {inter_rois['credits']['roi'][0]})")

expected_face_x_i = (304 // 2) - (26 // 2)  # 139
ok(inter_rois["phase"]["roi"][0] == expected_face_x_i,
   f"Intermediate: face x={expected_face_x_i} (got {inter_rois['phase']['roi'][0]})")


# Beginner board window: ~180px wide
beg_frame = np.zeros((252, 180, 3), dtype=np.uint8)
beg_rois = _rois_for_frame(beg_frame, _hud)

ok(beg_rois["health"]["roi"][0] == 17, "Beginner: mine counter x=17 (same)")
expected_timer_x_b = 180 - 17 - 41  # 122
ok(beg_rois["credits"]["roi"][0] == expected_timer_x_b,
   f"Beginner: timer x={expected_timer_x_b} (got {beg_rois['credits']['roi'][0]})")

expected_face_x_b = (180 // 2) - (26 // 2)  # 77
ok(beg_rois["phase"]["roi"][0] == expected_face_x_b,
   f"Beginner: face x={expected_face_x_b} (got {beg_rois['phase']['roi'][0]})")


# -- SUITE B: Edge cases -----------------------------------------------------

section("SUITE B -- Edge cases")

# Too-small frame should fall back to profile defaults
tiny_frame = np.zeros((50, 50, 3), dtype=np.uint8)
tiny_rois = _rois_for_frame(tiny_frame, _hud)
ok(tiny_rois["health"]["roi"] == _hud["health"]["roi"],
   "Tiny frame: falls back to profile.json defaults")

# Very wide custom board (~900px)
wide_frame = np.zeros((346, 900, 3), dtype=np.uint8)
wide_rois = _rois_for_frame(wide_frame, _hud)
expected_timer_x_w = 900 - 17 - 41  # 842
ok(wide_rois["credits"]["roi"][0] == expected_timer_x_w,
   f"Wide board: timer x={expected_timer_x_w} (got {wide_rois['credits']['roi'][0]})")

expected_face_x_w = (900 // 2) - (26 // 2)  # 437
ok(wide_rois["phase"]["roi"][0] == expected_face_x_w,
   f"Wide board: face x={expected_face_x_w} (got {wide_rois['phase']['roi'][0]})")


# -- SUITE C: ROI dimensions are preserved -----------------------------------

section("SUITE C -- ROI dimensions preserved across difficulties")

for name, frame in [("expert", expert_frame), ("inter", inter_frame), ("beg", beg_frame)]:
    rois = _rois_for_frame(frame, _hud)
    ok(rois["health"]["roi"][2] == 41, f"{name}: mine counter width=41")
    ok(rois["health"]["roi"][3] == 23, f"{name}: mine counter height=23")
    ok(rois["credits"]["roi"][2] == 41, f"{name}: timer width=41")
    ok(rois["credits"]["roi"][3] == 23, f"{name}: timer height=23")
    ok(rois["phase"]["roi"][2] == 26, f"{name}: face width=26")
    ok(rois["phase"]["roi"][3] == 26, f"{name}: face height=26")


# -- SUITE D: Other HUD config preserved -------------------------------------

section("SUITE D -- Non-ROI config preserved")

ok(expert_rois["health"]["method"] == "ocr_number",
   "Expert: method preserved")
ok(expert_rois["health"]["range"] == [0, 999],
   "Expert: range preserved")
ok(expert_rois["phase"]["method"] == "face_state",
   "Expert: phase method preserved")


# -- Results -----------------------------------------------------------------

print(f"\n{'=' * 60}")
print(f"  Results: {_passed} passed, {_failed} failed")
print(f"{'=' * 60}\n")
sys.exit(1 if _failed > 0 else 0)
