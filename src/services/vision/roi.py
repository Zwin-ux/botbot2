"""
ROI (Region of Interest) utilities.

Handles:
  - Cropping a region from a frame
  - Scaling ROI coordinates between resolutions (profile ROIs are defined at 1920×1080)
  - Image preprocessing pipelines for OCR and brightness checks
"""

import logging
import numpy as np

log = logging.getLogger(__name__)

try:
    import cv2
    _CV2 = True
except ImportError:
    _CV2 = False
    log.warning("cv2 not available — ROI preprocessing will be skipped")


# ── Cropping ──────────────────────────────────────────────────────────────────

def crop(frame: np.ndarray, roi: list) -> np.ndarray:
    """Extract a [x, y, w, h] region from a BGR frame."""
    x, y, w, h = [int(v) for v in roi]
    return frame[y : y + h, x : x + w]


def scale_roi(roi: list, from_res: tuple, to_res: tuple) -> list:
    """
    Scale ROI from the profile's reference resolution to the actual capture resolution.

    profile.json defines ROIs for 1920×1080. If the player runs at 2560×1440
    everything needs to be scaled up, or at 1280×720 scaled down.

    Args:
        roi:      [x, y, w, h] at from_res
        from_res: (width, height) of the reference resolution
        to_res:   (width, height) of the actual capture

    Returns:
        scaled [x, y, w, h]
    """
    if from_res == to_res:
        return list(roi)
    x, y, w, h = roi
    sx = to_res[0] / from_res[0]
    sy = to_res[1] / from_res[1]
    return [int(x * sx), int(y * sy), max(1, int(w * sx)), max(1, int(h * sy))]


# ── OCR preprocessing ─────────────────────────────────────────────────────────

def preprocess_light_text(crop_img: np.ndarray) -> "np.ndarray | None":
    """
    Prepare a BGR crop for OCR where text is light (white/yellow) on a dark background.
    Valorant's HUD uses this convention throughout (health, credits, round number).

    Pipeline:
      1. Grayscale
      2. Upscale 2× — Tesseract accuracy degrades below ~30 px text height;
         most Valorant HUD text is 14–22 px at 1080p.
      3. OTSU threshold — automatically finds the cut-point between text and bg.
         Works well when there is clear contrast (dark bg + bright text).
      4. Invert — Tesseract strongly prefers dark text on white background.
      5. Small dilation — reconnects any broken character strokes after threshold.

    Jitter note: if OTSU produces an all-black or all-white result (text and
    background have similar brightness, e.g. grey text on grey bg), fall back to
    a fixed threshold of 128. Caller should detect this by checking if non-zero
    pixel ratio is < 0.02 or > 0.98.
    """
    if not _CV2 or crop_img is None or crop_img.size == 0:
        return None

    gray = cv2.cvtColor(crop_img, cv2.COLOR_BGR2GRAY)

    h, w = gray.shape
    # Upscale — improves Tesseract accuracy on small text
    scaled = cv2.resize(gray, (w * 2, h * 2), interpolation=cv2.INTER_CUBIC)

    # OTSU threshold: auto-finds the foreground/background split
    _, bw = cv2.threshold(scaled, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # Sanity-check OTSU result — if it yielded near-uniform output, the contrast
    # was too low for auto-thresholding; fall back to a fixed mid-point.
    nonzero_ratio = np.count_nonzero(bw) / bw.size
    if nonzero_ratio < 0.03 or nonzero_ratio > 0.97:
        # OTSU failed — use fixed threshold and hope for the best
        _, bw = cv2.threshold(scaled, 140, 255, cv2.THRESH_BINARY)

    # Invert so Tesseract sees dark text on white
    inverted = cv2.bitwise_not(bw)

    # Light dilation reconnects broken character strokes
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
    dilated = cv2.dilate(inverted, kernel, iterations=1)

    return dilated


def preprocess_number_crop(crop_img: np.ndarray, upscale: int = 2) -> "np.ndarray | None":
    """
    Faster variant for pure-numeric fields (health, credits).
    Enhances white/bright pixels specifically to handle color text (yellow credits).
    """
    if not _CV2 or crop_img is None or crop_img.size == 0:
        return None

    # Convert to grayscale — yellow and white both appear bright
    gray = cv2.cvtColor(crop_img, cv2.COLOR_BGR2GRAY)

    h, w = gray.shape
    scaled = cv2.resize(gray, (w * upscale, h * upscale), interpolation=cv2.INTER_CUBIC)

    # Use a lower fixed threshold to catch yellow text (which is slightly dimmer
    # than pure white in grayscale). Valorant HUD backgrounds are typically < 60.
    # Yellow text (~RGB 220,200,60) grayscale ≈ 190; white ≈ 240.
    # Setting threshold at 120 captures both.
    _, bw = cv2.threshold(scaled, 120, 255, cv2.THRESH_BINARY)

    return cv2.bitwise_not(bw)


# ── Brightness / saturation ───────────────────────────────────────────────────

def mean_brightness(crop_img: np.ndarray) -> float:
    """Mean pixel intensity (0–255) of a BGR image."""
    if not _CV2 or crop_img is None or crop_img.size == 0:
        return 0.0
    gray = cv2.cvtColor(crop_img, cv2.COLOR_BGR2GRAY)
    return float(np.mean(gray))


def mean_saturation(crop_img: np.ndarray) -> float:
    """
    Mean saturation (0–255) in HSV space.
    Ready abilities in Valorant have a coloured glow (high saturation).
    Cooldown / greyed-out abilities have near-zero saturation.
    """
    if not _CV2 or crop_img is None or crop_img.size == 0:
        return 0.0
    hsv = cv2.cvtColor(crop_img, cv2.COLOR_BGR2HSV)
    return float(np.mean(hsv[:, :, 1]))  # S channel
