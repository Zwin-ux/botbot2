"""
Valorant frame detector.

Interface: detect(frame: np.ndarray, profile: dict) -> dict

Returns raw (unsmoothed) per-frame readings. Temporal smoothing is applied
upstream in FrameDetector (detect.py). Keep this module stateless.

HUD layout reference (1920×1080, standard settings):
  Health       bottom-center, white text on dark panel, ~860×1020
  Credits      bottom-center, yellow/gold text, ~820×955
  Round #      top-center, white text, ~930×30
  Phase text   top-center, white text, ~870×50
  Abilities    bottom-center row: C(~840) Q(~732) E(~786) X(~894)  y~1010
  Kill feed    top-right, white text on semi-transparent strip, ~1400×60

ROI coordinates come from profile.json — the detector reads them rather than
hardcoding, so you can tune them without touching this file.

OCR jitter notes (inline):
  [JITTER] marks spots where specific preprocessing decisions were made to
  reduce noise. If you're getting bad reads, start there.
"""

import logging
import os
import re
import sys
from typing import Optional

import numpy as np

log = logging.getLogger(__name__)

# ── Optional deps — fail softly so test mode can report what's missing ─────

try:
    import cv2
    _CV2 = True
except ImportError:
    _CV2 = False
    log.error("cv2 not available. Run: pip install opencv-python-headless")

try:
    import pytesseract

    # Windows: Tesseract is rarely on PATH after installer — check the default location.
    _WIN_TESS = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
    if os.path.isfile(_WIN_TESS):
        pytesseract.pytesseract.tesseract_cmd = _WIN_TESS

    # Quick smoke-test so we know early if Tesseract binary is missing
    pytesseract.get_tesseract_version()
    _TESS = True
except Exception:
    _TESS = False
    log.error(
        "Tesseract not available or binary not found. "
        "Install from: https://github.com/UB-Mannheim/tesseract/wiki"
    )

# Add vision service directory to path so we can import roi.py
_VISION_DIR = os.path.join(os.path.dirname(__file__), "../../services/vision")
if _VISION_DIR not in sys.path:
    sys.path.insert(0, os.path.abspath(_VISION_DIR))

try:
    from roi import (
        crop,
        mean_brightness,
        mean_saturation,
        preprocess_light_text,
        preprocess_number_crop,
    )
    _ROI = True
except ImportError:
    _ROI = False
    log.error("roi.py not found — check sys.path")


# ── Public interface ──────────────────────────────────────────────────────────

def detect(frame: np.ndarray, profile: dict) -> dict:
    """
    Run all enabled detectors for a single frame.

    Returns a flat dict of raw readings — values are int/str/bool/None.
    None means "could not read this frame" — the smoother upstream will
    hold the last known good value.
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

    hud = profile.get("hud", {})

    if "health" in hud:
        result["health"] = _read_health(frame, hud["health"])

    if "credits" in hud:
        result["credits"] = _read_credits(frame, hud["credits"])

    if "roundNumber" in hud:
        result["round_number"] = _read_round_number(frame, hud["roundNumber"])

    if "phase" in hud:
        result["phase"] = _read_phase(frame, hud["phase"])

    if "abilities" in hud:
        result["abilities"] = _read_abilities(frame, hud["abilities"])

    return result


# ── Individual field readers ──────────────────────────────────────────────────

def _read_health(frame: np.ndarray, cfg: dict) -> Optional[int]:
    """
    Read the numeric health value from the HUD.

    Valorant shows health as white digits (e.g. "87") on a dark panel.
    The bar itself is separate from the number — we only look at the number ROI.

    [JITTER] Health OCR is one of the most stable fields: digits are large,
    white on dark, and rarely occluded. If you're getting None frequently,
    the ROI is probably slightly off — try expanding it by 5–10px in each direction.
    """
    return _ocr_int(frame, cfg["roi"], cfg.get("range", [0, 100]), "health")


def _read_credits(frame: np.ndarray, cfg: dict) -> Optional[int]:
    """
    Read the credit/economy value.

    Credits appear as yellow-gold text on a dark HUD strip. Yellow pixels
    appear bright in grayscale (~190 intensity), so the standard light-text
    preprocessor handles this correctly.

    [JITTER] Credits are only visible during buy phase. During combat the ROI
    shows a dark panel with no text, which OTSU interprets as all-noise.
    This reliably produces None, which is correct (smoother holds last known value).
    """
    return _ocr_int(frame, cfg["roi"], cfg.get("range", [0, 9000]), "credits")


def _read_round_number(frame: np.ndarray, cfg: dict) -> Optional[int]:
    """
    Read the current round number from the top-center of the HUD.

    [JITTER] This is a 1–2 digit number in a small ROI. If OCR misreads it,
    widen the ROI width by 10px and height by 6px in profile.json.
    """
    return _ocr_int(frame, cfg["roi"], [1, 30], "round_number")


def _read_phase(frame: np.ndarray, cfg: dict) -> Optional[str]:
    """
    Detect the current game phase via OCR keyword matching.

    We avoid template matching (which requires pre-captured reference images)
    in favour of reading the phase text directly. Valorant always shows the
    same strings in the same location:
      - "BUY PHASE" or "BUYING" during buy phase
      - Round timer digits or nothing visible during combat
      - "WIN" / "LOSE" / "DEFEAT" at round end

    [JITTER] Phase OCR can pick up UI chrome (map name, agent names) if the
    ROI bleeds outside the phase banner. Keep the ROI tight to the text box.
    """
    if not _TESS:
        return None

    roi = cfg["roi"]
    crop_img = crop(frame, roi)
    processed = preprocess_light_text(crop_img)
    if processed is None:
        return None

    # PSM 7: treat the ROI as a single line of text
    raw = _run_ocr(processed, psm=7, digits_only=False)
    if not raw:
        return None

    text = raw.upper()

    # Keyword matching — order matters (most specific first)
    if any(kw in text for kw in ("BUY", "BUYING", "PURCHASE")):
        return "buy"
    if any(kw in text for kw in ("WIN", "VICTORY")):
        return "end_win"
    if any(kw in text for kw in ("LOSE", "DEFEAT", "LOST")):
        return "end_loss"
    if any(kw in text for kw in ("SPIKE", "DEFUSE", "PLANT")):
        return "combat"

    # If we see only digits it's likely a round timer — combat phase
    if re.fullmatch(r"[\d:.\s]+", text.strip()):
        return "combat"

    return None


def _read_abilities(frame: np.ndarray, cfg: dict) -> dict:
    """
    Detect readiness for C, Q, E, X ability slots.

    Method: for each slot, we analyse the icon ROI using a combination of
    mean brightness and mean saturation in HSV space.

      Ready state:    bright + colourful (Valorant colours the icon and adds a glow)
      Cooldown state: dim + desaturated  (icon is grey/dark)

    [JITTER] The threshold values in profile.json need tuning per agent and
    per monitor brightness. A global brightness of 160 works for most agents
    in a dark room; increase to 180 if a very bright wallpaper is bleeding into
    the HUD, or decrease to 140 on dim monitors.

    The ult slot (X) uses a higher brightness + saturation check because the
    ult bar glow is more pronounced than regular abilities. Its threshold is
    set separately in profile.json.
    """
    abilities = {}
    for slot, slot_cfg in cfg.items():
        roi = slot_cfg["roi"]
        brightness_thresh = slot_cfg.get("threshold", 160)

        crop_img = crop(frame, roi)
        if crop_img is None or crop_img.size == 0:
            abilities[slot] = False
            continue

        brightness = mean_brightness(crop_img)
        saturation = mean_saturation(crop_img)

        # An ability is "ready" if its icon is both bright AND has colour.
        # The saturation check prevents bright white/grey UI elements from
        # triggering false positives when the ability is actually on cooldown.
        sat_threshold = slot_cfg.get("saturation_threshold", 40)
        ready = brightness > brightness_thresh and saturation > sat_threshold

        abilities[slot] = ready

    return abilities


# ── OCR helpers ───────────────────────────────────────────────────────────────

def _ocr_int(
    frame: np.ndarray,
    roi: list,
    value_range: list,
    field_name: str = "",
) -> Optional[int]:
    """
    Run OCR on a numeric HUD field and return a validated integer.

    Returns None if:
      - Tesseract finds no digit sequence
      - The parsed value falls outside value_range
      - Any exception occurs during OCR (never crash the capture loop)

    [JITTER] The most common failure mode here is OCR returning a partial read:
    "87" → "8" or "7". This can be caused by:
      1. ROI too small (text clips at the edge) — fix: expand ROI
      2. Low contrast after thresholding  — fix: check preprocess_number_crop params
      3. Tesseract not detecting word boundaries — fix: add 4px padding to the crop

    The value_range guard catches out-of-range misreads (e.g., "387" instead of "87")
    without crashing. Values outside range are treated as None and smoothed away.
    """
    if not _TESS or not _ROI:
        return None

    try:
        crop_img = crop(frame, roi)
        processed = preprocess_number_crop(crop_img)
        if processed is None:
            return None

        # PSM 8: single word (tighter, faster, better for short numbers)
        raw = _run_ocr(processed, psm=8, digits_only=True)
        if not raw:
            # [JITTER] Fallback: retry with PSM 7 (single line) in case the field
            # spans more horizontal space than expected
            raw = _run_ocr(processed, psm=7, digits_only=True)

        if not raw:
            return None

        m = re.search(r"\d+", raw)
        if not m:
            return None

        value = int(m.group())
        lo, hi = value_range
        if not (lo <= value <= hi):
            log.debug(f"[detector] {field_name} OCR value {value} out of range [{lo},{hi}]")
            return None

        return value

    except Exception as e:
        log.warning(f"[detector] _ocr_int({field_name}) failed: {e}")
        return None


def _run_ocr(img: np.ndarray, psm: int = 7, digits_only: bool = True) -> str:
    """
    Call pytesseract with consistent config.

    psm 7  = single text line (good for phase text, round number)
    psm 8  = single word     (good for health, credits)
    psm 10 = single character (avoid — too aggressive)

    [JITTER] If Tesseract returns garbage characters, the issue is almost
    always in the preprocessed image. Save `img` to disk and inspect it:
        cv2.imwrite("debug_crop.png", img)
    """
    if not _TESS:
        return ""

    char_whitelist = "0123456789" if digits_only else "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 :.-_"
    config = f"--psm {psm} -c tessedit_char_whitelist={char_whitelist} --oem 1"

    try:
        text = pytesseract.image_to_string(img, config=config)
        return text.strip()
    except Exception as e:
        log.debug(f"[detector] tesseract error: {e}")
        return ""
