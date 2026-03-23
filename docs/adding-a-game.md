# Adding a New Game Profile

This guide walks through creating a GamePartner profile for a new game.
No changes to the core engine are needed — all game logic lives in two files.

---

## Prerequisites

- Node.js ≥ 18 and Python ≥ 3.10 installed
- Tesseract OCR ≥ 5.0 installed (see README for Windows installer link)
- A screenshot of the game at your target resolution (1920×1080 recommended)
- `pip install -r src/services/vision/requirements.txt` completed

---

## Step 1 — Create the profile directory

```bash
mkdir src/profiles/<game>
```

Replace `<game>` with a short lowercase identifier (e.g. `cs2`, `apex`, `overwatch`).

---

## Step 2 — Calibrate ROIs

ROIs (regions of interest) are pixel rectangles `[x, y, width, height]` that
tell the detector where each HUD element lives on screen.

1. Take a screenshot of the game at your target resolution and save it somewhere
   accessible (e.g. `recordings/my_screenshot.png`). Create the `recordings/`
   directory if it doesn't already exist:

   ```bash
   mkdir recordings
   ```

2. Run the interactive calibration tool:

   ```bash
   python tools/calibrate_rois.py --capture
   ```

   The tool lets you draw rectangles over HUD elements and prints the `[x, y, w, h]`
   values to copy into `profile.json`.

3. For each HUD field you want to detect (health, credits, phase, etc.), draw a
   tight bounding box around the text or icon.

**Tips:**
- Add 2–4 px padding around text to avoid clipping.
- Credits are only visible during the buy phase — use a screenshot taken during buying.
- Ability icons change brightness when ready vs. on cooldown — you don't need OCR here.

---

## Step 3 — Write profile.json

Create `src/profiles/<game>/profile.json`. Copy and adapt the Valorant profile
(`src/profiles/valorant/profile.json`) as a starting point.

```jsonc
{
  "name": "My Game",
  "game": "<game>",           // must match the directory name
  "version": "1.0.0",
  "resolution": [1920, 1080],
  "maxDecisionsPerFrame": 2,

  "hud": {
    // Add HUD fields here using the ROIs from Step 2.
    // See src/profiles/README.md for the full schema.
    "health": {
      "roi": [X, Y, W, H],
      "method": "ocr_number",
      "range": [0, 100]
    }
  },

  "rules": [
    // Add decision rules here.
    // See src/profiles/README.md for the full rule schema.
    {
      "id": "health_critical",
      "trigger": "health.change",
      "condition": { "payload.current": { "$lte": 25 } },
      "priority": "critical",
      "cooldown": 5000,
      "output": {
        "message": "Critical HP — act now",
        "ttl": 8000
      }
    }
  ]
}
```

See [`src/profiles/README.md`](../src/profiles/README.md) for a full reference of
HUD methods, condition operators, and rule fields.

---

## Step 4 — Write detector.py

Create `src/profiles/<game>/detector.py`. The minimum viable implementation:

```python
"""
<Game> frame detector.
Interface: detect(frame: np.ndarray, profile: dict) -> dict
"""
import logging
import sys
import os

import numpy as np

log = logging.getLogger(__name__)

# Add vision service to path for roi helpers
_VISION_DIR = os.path.join(os.path.dirname(__file__), "../../services/vision")
if _VISION_DIR not in sys.path:
    sys.path.insert(0, os.path.abspath(_VISION_DIR))

try:
    import cv2
    _CV2 = True
except ImportError:
    _CV2 = False

try:
    import pytesseract
    pytesseract.get_tesseract_version()
    _TESS = True
except Exception:
    _TESS = False

try:
    from roi import crop, preprocess_number_crop
    _ROI = True
except ImportError:
    _ROI = False


def detect(frame: np.ndarray, profile: dict) -> dict:
    result = {
        "health": None,
        "credits": None,
        "phase": None,
        "round_number": None,
        "abilities": {},
        "spike_state": None,
    }

    if not _CV2 or not _ROI:
        return result

    hud = profile.get("hud", {})

    if "health" in hud:
        result["health"] = _read_health(frame, hud["health"])

    # Add more fields here as you implement them.

    return result


def _read_health(frame, cfg):
    """Read health value via OCR."""
    if not _TESS or not _ROI:
        return None
    try:
        import re
        from roi import preprocess_number_crop
        crop_img = crop(frame, cfg["roi"])
        processed = preprocess_number_crop(crop_img)
        if processed is None:
            return None
        raw = pytesseract.image_to_string(
            processed,
            config="--psm 8 -c tessedit_char_whitelist=0123456789 --oem 1"
        ).strip()
        m = re.search(r"\d+", raw)
        if not m:
            return None
        value = int(m.group())
        lo, hi = cfg.get("range", [0, 100])
        return value if lo <= value <= hi else None
    except Exception as e:
        log.warning(f"[detector] _read_health failed: {e}")
        return None
```

---

## Step 5 — Test with the synthetic profile first (optional but recommended)

Before testing with a live game, verify the pipeline works end-to-end using the
synthetic test harness:

```bash
python tests/test_vision_pipeline.py
```

This requires only `numpy` — no OpenCV or Tesseract needed.

---

## Step 6 — Test with a real screenshot

```bash
python src/services/vision/server.py --test path/to/screenshot.png
```

This runs a single frame through your detector and prints the raw detections.

---

## Step 7 — Activate the profile

In `config/default.json`, set:

```json
"activeProfile": "<game>"
```

Then start GamePartner:

```bash
npm start
```

The launcher will pick up your profile automatically.

---

## Step 8 — Iterate

1. If a field reads incorrectly, adjust the ROI in `profile.json` and re-run `--test`.
2. Once readings are stable, add decision rules to `profile.json`.
3. Bump `version` to `2.0.0` after ROI calibration is confirmed.

---

## Reference

- **Profile schema**: [`src/profiles/README.md`](../src/profiles/README.md)
- **Example profile**: [`src/profiles/valorant/`](../src/profiles/valorant/)
- **Synthetic test harness**: [`src/profiles/synthetic/`](../src/profiles/synthetic/)
- **ROI helpers**: [`src/services/vision/roi.py`](../src/services/vision/roi.py)
