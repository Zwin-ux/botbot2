"""
Minesweeper frame detector.

Interface: detect(frame: np.ndarray, profile: dict) -> dict

Reads three HUD fields from Microsoft Minesweeper (Windows):
  - Mine counter   (top-left, red 7-segment LCD digits)
  - Timer          (top-right, red 7-segment LCD digits)
  - Game state     (centre face button: smiley=playing, dead=lost, sunglasses=won)

Field mapping to the standard pipeline:
  health  -> mines remaining (0–999)
  credits -> timer seconds   (0–999)
  phase   -> "playing" / "end_loss" / "end_win"

ROI coordinates are read from profile.json. Default ROIs are calibrated
for the classic Windows Minesweeper layout at default Expert board size.
The detector also auto-detects difficulty (Beginner/Intermediate/Expert)
from the window dimensions and adjusts ROI positions accordingly.

OCR notes:
  The 7-segment LCD digits are bright red on black, making them ideal for
  simple red-channel thresholding + Tesseract PSM 8 (single word, digits only).
"""

import logging
import os
import re
import sys
from typing import Optional

import numpy as np

log = logging.getLogger(__name__)

# ── Optional deps — fail softly so tests can run without them ────────────────

try:
    import cv2
    _CV2 = True
except ImportError:
    _CV2 = False
    log.error("cv2 not available. Run: pip install opencv-python-headless")

try:
    import pytesseract

    _WIN_TESS = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
    if os.path.isfile(_WIN_TESS):
        pytesseract.pytesseract.tesseract_cmd = _WIN_TESS

    pytesseract.get_tesseract_version()
    _TESS = True
except Exception:
    _TESS = False
    log.error("Tesseract not available or binary not found.")

# Add vision service directory to path for roi.py helpers
_VISION_DIR = os.path.join(os.path.dirname(__file__), "../../services/vision")
if _VISION_DIR not in sys.path:
    sys.path.insert(0, os.path.abspath(_VISION_DIR))

try:
    from roi import crop
    _ROI = True
except ImportError:
    _ROI = False
    log.error("roi.py not found — check sys.path")


# ── Difficulty-aware ROI sets ────────────────────────────────────────────────
# Classic Minesweeper window sizes (client area, approximate):
#   Beginner:     ~180 x 252   (9×9 board,  10 mines)
#   Intermediate: ~304 x 346   (16×16 board, 40 mines)
#   Expert:       ~488 x 346   (30×16 board, 99 mines)
#
# The header bar layout is the same across difficulties:
#   - Mine counter always at top-left (x≈17, y≈56)
#   - Timer always at top-right (x depends on window width)
#   - Face button always centred (x = window_width/2 - 13)
#
# ROI format: [x, y, w, h]

_HEADER_Y      = 56   # y position of LCD/face in header bar
_LCD_W         = 41   # width of 3-digit LCD
_LCD_H         = 23   # height of LCD
_FACE_W        = 26   # face button width
_FACE_H        = 26   # face button height
_MINE_X        = 17   # mine counter x (same for all difficulties)
_RIGHT_PAD     = 17   # padding from right edge to timer

# Window width thresholds for difficulty detection
_BEGINNER_MAX_W     = 220   # narrower than this = Beginner
_INTERMEDIATE_MAX_W = 380   # narrower than this = Intermediate
# wider = Expert


def _rois_for_frame(frame: np.ndarray, profile_hud: dict) -> dict:
    """
    Return ROIs adjusted for the actual frame (window) dimensions.

    If the frame width matches a known difficulty, compute timer and face
    positions dynamically. Otherwise fall back to profile.json ROIs.
    """
    h, w = frame.shape[:2]

    if w < 80 or h < 80:
        # Too small to be a real game window — use profile defaults
        return profile_hud

    # Compute dynamic ROIs based on window width
    timer_x = w - _RIGHT_PAD - _LCD_W
    face_x  = (w // 2) - (_FACE_W // 2)

    adjusted = {}
    for key, cfg in profile_hud.items():
        adjusted[key] = dict(cfg)  # shallow copy

    # Override with computed positions
    if "health" in adjusted:
        adjusted["health"]["roi"] = [_MINE_X, _HEADER_Y, _LCD_W, _LCD_H]
    if "credits" in adjusted:
        adjusted["credits"]["roi"] = [timer_x, _HEADER_Y, _LCD_W, _LCD_H]
    if "phase" in adjusted:
        adjusted["phase"]["roi"] = [face_x, _HEADER_Y - 3, _FACE_W, _FACE_H]

    return adjusted


# ── Public interface ─────────────────────────────────────────────────────────

def detect(frame: np.ndarray, profile: dict) -> dict:
    """
    Run all detectors for a single Minesweeper frame.

    Returns the standard dict shape. None means "could not read this frame".
    """
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

    hud = _rois_for_frame(frame, profile.get("hud", {}))

    # Mine counter -> health
    if "health" in hud:
        result["health"] = _read_lcd_number(frame, hud["health"])

    # Timer -> credits
    if "credits" in hud:
        result["credits"] = _read_lcd_number(frame, hud["credits"])

    # Face state -> phase
    if "phase" in hud:
        result["phase"] = _read_face_state(frame, hud["phase"])

    return result


# ── Field readers ────────────────────────────────────────────────────────────

def _read_lcd_number(frame: np.ndarray, cfg: dict) -> Optional[int]:
    """
    Read a 7-segment LCD number (red digits on black background).

    Preprocessing:
      1. Crop ROI
      2. Extract red channel (the digits are bright red)
      3. Threshold: red > 150 → white, else black
      4. Invert for Tesseract (black text on white background)
      5. Add padding for better OCR accuracy
      6. Run Tesseract PSM 8 digits-only
    """
    if not _TESS:
        return None

    try:
        roi = cfg["roi"]
        lo, hi = cfg.get("range", [0, 999])

        crop_img = crop(frame, roi)
        if crop_img is None or crop_img.size == 0:
            return None

        # Red channel extraction — 7-segment digits are bright red
        if len(crop_img.shape) == 3:
            # BGR format: red is channel 2
            red = crop_img[:, :, 2]
        else:
            red = crop_img

        # Threshold to isolate bright red segments
        _, binary = cv2.threshold(red, 150, 255, cv2.THRESH_BINARY)

        # Invert: Tesseract expects dark text on light background
        inverted = cv2.bitwise_not(binary)

        # Add padding for Tesseract accuracy
        padded = cv2.copyMakeBorder(
            inverted, 8, 8, 8, 8,
            cv2.BORDER_CONSTANT, value=255
        )

        # OCR — PSM 8: single word, digits only
        config = "--psm 8 -c tessedit_char_whitelist=0123456789 --oem 1"
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
        log.warning(f"[minesweeper] _read_lcd_number failed: {e}")
        return None


def _read_face_state(frame: np.ndarray, cfg: dict) -> Optional[str]:
    """
    Detect game state from the centre face button.

    Method: Analyse colour distribution in the face ROI.
      - Smiley face (playing): bright yellow, high mean brightness
      - Dead face (lost):      red-tinted, lower brightness
      - Sunglasses (won):      dark lenses reduce mean brightness but
                               strong yellow border remains

    We use a simple heuristic based on the ratio of yellow vs red pixels.
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

        # Count red-ish pixels (hue 0-10 or 170-180, with saturation > 80)
        red_mask = ((h < 10) | (h > 170)) & (s > 80)
        red_ratio = float(np.sum(red_mask)) / max(red_mask.size, 1)

        # Very low brightness = empty/grey = no active game
        if mean_val < 40:
            return None

        # High red ratio = dead face (game over / lost)
        if red_ratio > 0.15:
            return "end_loss"

        # High brightness + saturation = active face
        if mean_val > 120 and mean_sat > 60:
            # Sunglasses face has lower overall brightness due to dark lenses
            # but still has strong yellow. Check if brightness is moderate.
            if mean_val < 160 and mean_sat > 80:
                return "end_win"
            return "playing"

        # Moderate brightness without strong colour = neutral/unknown
        if mean_val > 80:
            return "playing"

        return None

    except Exception as e:
        log.warning(f"[minesweeper] _read_face_state failed: {e}")
        return None
