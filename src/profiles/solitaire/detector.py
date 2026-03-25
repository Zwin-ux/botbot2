"""
Solitaire frame detector.

Interface: detect(frame: np.ndarray, profile: dict) -> dict

Reads HUD fields from classic Windows Solitaire:
  - Score      (status bar, white/black text)
  - Move count (status bar)
  - Game state (tableau brightness analysis for won/playing)

Field mapping to standard pipeline:
  health  -> score (0-9999)
  credits -> move count (0-999)
  phase   -> "playing" / "end_win"

Designed for classic Solitaire (sol.exe / third-party clones).
For Microsoft Solitaire Collection, ROIs need recalibration.
"""

import logging
import os
import re
import sys
from typing import Optional

import numpy as np

log = logging.getLogger(__name__)

# ── Optional deps ─────────────────────────────────────────────────────────────

try:
    import cv2
    _CV2 = True
except ImportError:
    _CV2 = False

try:
    import pytesseract
    _WIN_TESS = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
    if os.path.isfile(_WIN_TESS):
        pytesseract.pytesseract.tesseract_cmd = _WIN_TESS
    pytesseract.get_tesseract_version()
    _TESS = True
except Exception:
    _TESS = False

_VISION_DIR = os.path.join(os.path.dirname(__file__), "../../services/vision")
if _VISION_DIR not in sys.path:
    sys.path.insert(0, os.path.abspath(_VISION_DIR))

try:
    from roi import crop
    _ROI = True
except ImportError:
    _ROI = False


# ── Public interface ─────────────────────────────────────────────────────────

def detect(frame: np.ndarray, profile: dict) -> dict:
    """Run all detectors for a single Solitaire frame."""
    result = {
        "health":       None,
        "credits":      None,
        "phase":        None,
        "round_number": None,
        "abilities":    {},
        "spike_state":  None,
    }

    if not _CV2 or not _ROI:
        return result

    hud = profile.get("hud", {})

    # Score -> health
    if "health" in hud:
        result["health"] = _read_status_number(frame, hud["health"])

    # Move count -> credits
    if "credits" in hud:
        result["credits"] = _read_status_number(frame, hud["credits"])

    # Game state -> phase
    if "phase" in hud:
        result["phase"] = _read_game_state(frame, hud["phase"])

    return result


# ── Field readers ────────────────────────────────────────────────────────────

def _read_status_number(frame: np.ndarray, cfg: dict) -> Optional[int]:
    """
    Read a number from the Solitaire status bar or score area.

    Classic Solitaire uses dark text on a light status bar.
    Modern Solitaire Collection uses white text on dark backgrounds.
    We try both approaches: light-text and dark-text preprocessing.
    """
    if not _TESS:
        return None

    try:
        roi = cfg["roi"]
        lo, hi = cfg.get("range", [0, 9999])

        crop_img = crop(frame, roi)
        if crop_img is None or crop_img.size == 0:
            return None

        gray = cv2.cvtColor(crop_img, cv2.COLOR_BGR2GRAY) if len(crop_img.shape) == 3 else crop_img

        # Strategy 1: dark text on light bg (classic Solitaire status bar)
        value = _try_ocr_number(gray, lo, hi, threshold=127, invert=False)
        if value is not None:
            return value

        # Strategy 2: light text on dark bg (modern Solitaire / other themes)
        value = _try_ocr_number(gray, lo, hi, threshold=160, invert=True)
        return value

    except Exception as e:
        log.warning(f"[solitaire] _read_status_number failed: {e}")
        return None


def _try_ocr_number(gray: np.ndarray, lo: int, hi: int,
                    threshold: int = 127, invert: bool = False) -> Optional[int]:
    """Try OCR with a specific threshold strategy."""
    try:
        if invert:
            _, binary = cv2.threshold(gray, threshold, 255, cv2.THRESH_BINARY)
            processed = cv2.bitwise_not(binary)
        else:
            _, processed = cv2.threshold(gray, threshold, 255, cv2.THRESH_BINARY_INV)

        padded = cv2.copyMakeBorder(processed, 6, 6, 6, 6, cv2.BORDER_CONSTANT, value=255)

        config = "--psm 8 -c tessedit_char_whitelist=0123456789 --oem 1"
        raw = pytesseract.image_to_string(padded, config=config).strip()

        if not raw:
            return None

        m = re.search(r"\d+", raw)
        if not m:
            return None

        value = int(m.group())
        if lo <= value <= hi:
            return value

        return None
    except Exception:
        return None


def _read_game_state(frame: np.ndarray, cfg: dict) -> Optional[str]:
    """
    Detect game state by analysing the tableau area.

    Heuristic: when the game is won, the tableau is mostly empty (green felt
    background) and the foundation piles are full (four stacks of 13 cards).

    We use a simple brightness/colour approach:
      - Very uniform green = game not started or won
      - Mixed colours with card edges = playing
      - Win animation (cards bouncing) = high variance, many colours

    For reliable win detection, we check the top portion of the tableau:
    if it's mostly uniform (low variance) AND has green-ish hue, the game
    may be won or not started. Combined with a high score, this signals a win.
    """
    try:
        roi = cfg["roi"]
        crop_img = crop(frame, roi)
        if crop_img is None or crop_img.size == 0:
            return None

        if len(crop_img.shape) < 3:
            return None

        # Convert to HSV for colour analysis
        hsv = cv2.cvtColor(crop_img, cv2.COLOR_BGR2HSV)
        h, s, v = cv2.split(hsv)

        mean_val = float(np.mean(v))
        mean_sat = float(np.mean(s))
        val_std = float(np.std(v))

        # Very low brightness = window minimized or covered
        if mean_val < 20:
            return None

        # High value variance = cards present = playing
        # Low variance + green hue = empty tableau (won or not started)
        # We can't distinguish won from not-started purely from the tableau,
        # but the upstream decision engine uses score > 0 to confirm a win.

        # Green felt detection (classic Solitaire: hue ~60-90 in OpenCV scale)
        green_mask = (h > 30) & (h < 90) & (s > 40) & (v > 40)
        green_ratio = float(np.sum(green_mask)) / max(green_mask.size, 1)

        # Win animation has high variance + many colours
        if val_std > 60:
            # Could be win animation or active play
            if green_ratio < 0.3:
                # Low green = cards everywhere = playing or animation
                return "playing"

        # Mostly green + low variance = empty or won
        if green_ratio > 0.6 and val_std < 35:
            # This is ambiguous — could be not started or won
            # Return "end_win" and let the rule engine check score
            return "end_win"

        # Normal play: mixed colours, moderate variance
        if mean_val > 40:
            return "playing"

        return None

    except Exception as e:
        log.warning(f"[solitaire] _read_game_state failed: {e}")
        return None
