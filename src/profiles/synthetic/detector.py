"""
Synthetic game detector — pure NumPy, no OpenCV or Tesseract required.

Values are encoded directly into pixel channel 0 (blue in BGR) at the
origin pixel of each ROI. This lets the vision pipeline run end-to-end
in CI without any system dependencies.

Encoding conventions:
  health:       frame[roi_y, roi_x, 0]        = health value (0–100)
  credits:      frame[roi_y, roi_x,     0]    = credits // 100  (high byte)
                frame[roi_y, roi_x + 1, 0]    = credits  % 100  (low byte)
  round_number: frame[roi_y, roi_x, 0]        = round number (1–30)
  phase:        frame[roi_y, roi_x, 0]        = phase code:
                    0=None  1="buy"  2="combat"  3="end_win"  4="end_loss"
  abilities:    frame[roi_y, roi_x, 0]        = 255 if ready, 0 if not ready

See tests/frame_builder.py for the matching frame generator.
"""

import numpy as np

PHASE_MAP = {0: None, 1: "buy", 2: "combat", 3: "end_win", 4: "end_loss"}


def detect(frame: np.ndarray, profile: dict) -> dict:
    """
    Read all HUD fields from a synthetic frame.

    Returns the same dict shape as all other game detectors so the
    FrameDetector / smoother pipeline handles it identically.
    """
    hud = profile.get("hud", {})
    result = {
        "health":       None,
        "credits":      None,
        "phase":        None,
        "round_number": None,
        "abilities":    {},
        "spike_state":  None,
    }

    if frame is None or frame.size == 0:
        return result

    def read_pixel(roi):
        """Return channel-0 value at the ROI origin pixel."""
        x, y = int(roi[0]), int(roi[1])
        return int(frame[y, x, 0])

    if "health" in hud:
        cfg = hud["health"]
        lo, hi = cfg.get("range", [0, 100])
        val = read_pixel(cfg["roi"])
        result["health"] = val if lo <= val <= hi else None

    if "credits" in hud:
        cfg = hud["credits"]
        lo, hi = cfg.get("range", [0, 9000])
        roi = cfg["roi"]
        x, y = int(roi[0]), int(roi[1])
        hi_byte = int(frame[y, x,     0])
        lo_byte = int(frame[y, x + 1, 0])
        val = hi_byte * 100 + lo_byte
        result["credits"] = val if lo <= val <= hi else None

    if "roundNumber" in hud:
        val = read_pixel(hud["roundNumber"]["roi"])
        result["round_number"] = val if 1 <= val <= 30 else None

    if "phase" in hud:
        code = read_pixel(hud["phase"]["roi"])
        result["phase"] = PHASE_MAP.get(code)

    if "abilities" in hud:
        for slot, cfg in hud["abilities"].items():
            val = read_pixel(cfg["roi"])
            result["abilities"][slot] = val > 127

    return result
