"""
Counter-Strike 2 frame detector (stub).

Interface: detect(frame: np.ndarray, profile: dict) -> dict

Reads HUD fields from CS2:
  - Health (bottom-left, white text on dark panel)
  - Money  (bottom-left, above health)
  - Phase  (top-center, round timer area via keyword OCR)

This is a STUB detector. ROIs and OCR thresholds need calibration
against real CS2 screenshots before this profile is functional.
The detector reuses the same Tesseract pipeline as Valorant but
with CS2-specific preprocessing (white-on-dark text extraction).

Field mapping to standard pipeline:
  health  -> HP (0-100)
  credits -> money (0-16000)
  phase   -> "buy" / "combat" / "end_win" / "end_loss"
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
    """Run all detectors for a single CS2 frame."""
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

    if "health" in hud:
        result["health"] = _read_white_number(frame, hud["health"])

    if "credits" in hud:
        result["credits"] = _read_white_number(frame, hud["credits"])

    if "phase" in hud:
        result["phase"] = _read_phase_keywords(frame, hud["phase"])

    return result


# ── Field readers ────────────────────────────────────────────────────────────

def _read_white_number(frame: np.ndarray, cfg: dict) -> Optional[int]:
    """
    Read a white number on a dark background (CS2 HUD style).

    Preprocessing: grayscale → threshold bright pixels → invert → Tesseract PSM 7.
    """
    if not _TESS:
        return None

    try:
        roi = cfg["roi"]
        lo, hi = cfg.get("range", [0, 100])

        crop_img = crop(frame, roi)
        if crop_img is None or crop_img.size == 0:
            return None

        gray = cv2.cvtColor(crop_img, cv2.COLOR_BGR2GRAY) if len(crop_img.shape) == 3 else crop_img

        # Threshold: white text (>200 brightness) on dark bg
        _, binary = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY)

        # Invert for Tesseract (dark text on light bg)
        inverted = cv2.bitwise_not(binary)

        padded = cv2.copyMakeBorder(inverted, 8, 8, 8, 8, cv2.BORDER_CONSTANT, value=255)

        config = "--psm 7 -c tessedit_char_whitelist=0123456789 --oem 1"
        raw = pytesseract.image_to_string(padded, config=config).strip()

        if not raw:
            return None

        m = re.search(r"\d+", raw)
        if not m:
            return None

        value = int(m.group())
        if not (lo <= value <= hi):
            return None

        return value

    except Exception as e:
        log.warning(f"[cs2] _read_white_number failed: {e}")
        return None


def _read_phase_keywords(frame: np.ndarray, cfg: dict) -> Optional[str]:
    """
    Read the round timer area and match against keyword lists.
    """
    if not _TESS:
        return None

    try:
        roi = cfg["roi"]
        crop_img = crop(frame, roi)
        if crop_img is None or crop_img.size == 0:
            return None

        gray = cv2.cvtColor(crop_img, cv2.COLOR_BGR2GRAY) if len(crop_img.shape) == 3 else crop_img
        _, binary = cv2.threshold(gray, 180, 255, cv2.THRESH_BINARY)
        inverted = cv2.bitwise_not(binary)
        padded = cv2.copyMakeBorder(inverted, 6, 6, 6, 6, cv2.BORDER_CONSTANT, value=255)

        config = "--psm 7 --oem 1"
        raw = pytesseract.image_to_string(padded, config=config).strip().lower()

        if not raw:
            return None

        keywords = cfg.get("keywords", {})
        for phase, words in keywords.items():
            for word in words:
                if word in raw:
                    return phase

        return None

    except Exception as e:
        log.warning(f"[cs2] _read_phase_keywords failed: {e}")
        return None
