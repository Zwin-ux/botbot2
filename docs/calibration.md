# ROI Calibration Guide

GamePartner reads game state by OCR-ing specific regions of the screen (ROIs — Regions of Interest). Each game profile ships with default ROIs for 1920x1080, but your game window may differ depending on resolution, DPI scaling, or window size. This guide walks you through calibrating ROIs for your setup.

## Prerequisites

- Python 3.10+
- `pip install opencv-python-headless pytesseract mss numpy`
- Tesseract OCR installed ([download](https://github.com/UB-Mannheim/tesseract/wiki))
- A screenshot of the game in its normal playing state

## Quick Start

```bash
# 1. Take a screenshot of the game mid-play (Win+Shift+S or PrtScn)
#    Save it somewhere, e.g. screenshots/valorant_1080.png

# 2. Run the calibration tool
python tools/calibrate_rois.py --screenshot screenshots/valorant_1080.png --game valorant

# 3. Or capture the screen live (while the game is open)
python tools/calibrate_rois.py --capture --game minesweeper
```

## Controls

| Key | Action |
|-----|--------|
| **N** / Tab | Next ROI field |
| **P** | Previous ROI field |
| **E** | Edit — draw a new rectangle with the mouse |
| **T** | Test OCR on selected field (shows detected value) |
| **A** | Test ALL fields at once |
| **W/S/A/D** | Nudge ROI 1px (up/down/left/right) |
| **Shift+WASD** | Nudge 5px |
| **+** / **-** | Grow / shrink ROI by 2px each side |
| **S** | Save changes to profile.json |
| **R** | Reset selected ROI to last-saved value |
| **C** | Capture a fresh screenshot |
| **H** | Toggle help overlay |
| **Q** / Esc | Quit (warns if unsaved) |

## Step-by-Step Walkthrough

### 1. Capture a Reference Screenshot

Open the game and play until all HUD elements are visible:
- **Valorant**: Mid-round with health, credits, abilities, and round number showing
- **Minesweeper**: Mid-game with mine counter, timer, and face button visible
- **CS2**: Mid-round with health, money, and round timer visible

Take a screenshot (PrtScn) and save as PNG.

### 2. Open the Calibration Tool

```bash
python tools/calibrate_rois.py --screenshot your_screenshot.png --game valorant
```

A window opens showing your screenshot with colored rectangles overlaid on each ROI. The currently selected ROI is highlighted with a brighter border.

### 3. Adjust Each ROI

For each HUD field:
1. Press **N** to cycle to the field
2. Press **E** to enter draw mode — click and drag a rectangle around the text/element
3. Press **T** to test OCR — the detected value appears in the info panel
4. If the value is correct, move to the next field
5. If OCR is wrong, adjust with WASD nudging or redraw

### 4. Tips for Good OCR

- **Crop tightly**: Include only the text, not surrounding UI chrome
- **Include padding**: Leave 2-3px on each side so Tesseract doesn't clip letters
- **Avoid overlapping elements**: If two numbers overlap, split them into separate ROIs
- **White text on dark bg**: Valorant and CS2 use white HUD text — the detector's preprocessing handles this
- **7-segment displays**: Minesweeper uses LCD-style numbers — crop to include all 3 digits

### 5. Test All Fields

Press **A** to run OCR on every field simultaneously. The info panel shows:
- Field name
- Detected value
- Confidence score
- Pass/fail indicator

If a field shows `None` or a wrong value, its ROI needs adjustment.

### 6. Save

Press **S** to write the updated ROIs back to `src/profiles/<game>/profile.json`. The changes take effect next time the vision service starts.

## Recording Mode (Alternative)

If you prefer to calibrate against live gameplay:

1. Right-click the GamePartner tray icon
2. Click **Record 60s**
3. Play the game normally for 60 seconds
4. Screenshots are saved to `recordings/<game>-<timestamp>/`
5. Use any frame for calibration:

```bash
python tools/calibrate_rois.py --screenshot recordings/minesweeper-2024-01-15-143022/frame_0050.png --game minesweeper
```

## Replay Mode (Batch Verification)

After calibrating, verify your ROIs work across multiple frames:

```bash
python src/services/vision/server.py --replay recordings/minesweeper-2024-01-15-143022/ --game minesweeper
```

This prints a table showing detected values + confidence for every frame.

## ROI Format

Each ROI is stored as `[x, y, width, height]` in pixels, relative to the top-left of the capture area:

```json
{
  "health": {
    "roi": [860, 1020, 120, 30],
    "method": "ocr_number",
    "range": [0, 100]
  }
}
```

- `x, y` = top-left corner of the region
- `width, height` = size of the crop
- ROIs are authored for the resolution in `profile.json` → `"resolution": [1920, 1080]`
- The vision service auto-scales ROIs if your actual resolution differs

## Multi-Resolution Support

ROIs are defined for a reference resolution (usually 1920x1080). The vision service's `roi.scale_roi()` function automatically scales them to your actual capture resolution. You generally only need to calibrate once at your primary resolution.

If auto-scaling doesn't work well for your resolution, you can:
1. Calibrate at your native resolution
2. Update `"resolution"` in profile.json to match
3. Save — the scaling math uses your new reference

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "No image loaded" | Check the screenshot path exists and is a valid PNG/JPG |
| OCR returns `None` for everything | Tesseract may not be installed — run `tesseract --version` |
| Values are close but wrong | Nudge the ROI 1-2px with WASD, then re-test with T |
| Window too small to see | Your screenshot may be very high-res — resize it first |
| Arrow keys don't work | Known issue on some Windows OpenCV builds — use WASD instead |
| Minesweeper ROIs off | Minesweeper's window size depends on difficulty — recalibrate for your level |
