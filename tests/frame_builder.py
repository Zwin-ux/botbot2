"""
Synthetic frame builder for GamePartner vision pipeline tests.

Generates NumPy BGR arrays that encode game state as pixel values at
locations matching src/profiles/synthetic/profile.json ROI coordinates.

No OpenCV or Tesseract needed — pure NumPy.
"""

import numpy as np

# Phase name → pixel code stored in channel 0
PHASE_CODES = {
    None:       0,
    "buy":      1,
    "combat":   2,
    "end_win":  3,
    "end_loss": 4,
}

# ROI origins: (x, y) — must match profile.json exactly
_ROIS = {
    "health":       (10,  10),
    "credits":      (10,  40),
    "round_number": (10,  70),
    "phase":        (10, 100),
    "abilities": {
        "Q":  (10,  130),
        "E":  (40,  130),
        "C":  (70,  130),
        "X":  (100, 130),
    },
}


def make_frame(
    health: int = 100,
    credits: int = 3000,
    phase: str = "combat",
    round_number: int = 1,
    abilities: dict = None,
    width: int = 640,
    height: int = 480,
) -> np.ndarray:
    """
    Build a 640×480 BGR frame encoding the given game state.

    Values outside valid ranges are clamped so the detector always
    receives well-formed input (encoding errors are a test-fixture
    bug, not a detector bug).
    """
    if abilities is None:
        abilities = {"Q": False, "E": False, "C": False, "X": False}

    frame = np.zeros((height, width, 3), dtype=np.uint8)

    # Health (0–100) → channel 0 at roi origin
    x, y = _ROIS["health"]
    frame[y, x, 0] = int(max(0, min(100, health)))

    # Credits (0–9000) → two-byte split: hi = credits // 100, lo = credits % 100
    x, y = _ROIS["credits"]
    c = int(max(0, min(9000, credits)))
    frame[y, x,     0] = c // 100
    frame[y, x + 1, 0] = c  % 100

    # Round number (1–30) → channel 0
    x, y = _ROIS["round_number"]
    frame[y, x, 0] = int(max(1, min(30, round_number)))

    # Phase → code in channel 0
    x, y = _ROIS["phase"]
    frame[y, x, 0] = PHASE_CODES.get(phase, 0)

    # Abilities → 255=ready, 0=not-ready
    for slot, (ax, ay) in _ROIS["abilities"].items():
        frame[ay, ax, 0] = 255 if abilities.get(slot, False) else 0

    return frame


def make_meta(
    width: int = 640,
    height: int = 480,
    ts_ms: int = 1000,
) -> dict:
    """Return frame metadata matching the shape FrameDetector.detect() expects."""
    return {"width": width, "height": height, "ts_ms": ts_ms}
