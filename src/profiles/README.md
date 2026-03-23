# Game Profile Authoring Guide

A GamePartner profile consists of exactly two files placed in `src/profiles/<game>/`:

```
src/profiles/<game>/
├── profile.json   ← HUD layout + decision rules (declarative)
└── detector.py    ← Frame-level CV/OCR implementation (imperative)
```

To activate a profile, set `"activeProfile": "<game>"` in `config/default.json`.

---

## profile.json

### Top-level fields

| Field | Type | Description |
|---|---|---|
| `name` | string | Human-readable display name (e.g. `"Valorant"`) |
| `game` | string | Machine identifier matching `config/default.json` active profile |
| `version` | string | Semver. Bump to `x.x.0` after ROI calibration, `x.0.0` for schema changes |
| `resolution` | `[w, h]` | Reference resolution used when calibrating ROIs |
| `maxDecisionsPerFrame` | number | Cap on how many overlay alerts can fire per detection frame |
| `hud` | object | HUD field definitions (see below) |
| `rules` | array | Decision rules (see below) |

### HUD field definitions (`hud`)

Each key names a logical HUD field. The value describes how to detect it:

```jsonc
"health": {
  "roi": [x, y, width, height],  // pixel rectangle on the reference resolution
  "method": "ocr_number",        // detection method (see table below)
  "range": [0, 100]              // valid value range; reads outside range → null
}
```

**Detection methods**

| Method | Used for | Notes |
|---|---|---|
| `ocr_number` | Numeric fields (health, credits, round) | Tesseract PSM 8 with digits-only whitelist |
| `ocr_keyword` | Phase text | Tesseract PSM 7; detector maps keywords → canonical strings |
| `brightness_threshold` | Ability ready/cooldown | Checks mean brightness + saturation in HSV space |
| `multi_template` | Spike state | Template matching; requires reference images in `assets/` |
| `ocr_killfeed` | Kill feed entries | OCR on a multi-line strip; returns structured list |

### Ability slot config example

```json
"abilities": {
  "Q": { "roi": [732, 1010, 44, 44], "method": "brightness_threshold",
         "threshold": 155, "saturation_threshold": 35 },
  "X": { "roi": [894, 1010, 44, 44], "method": "brightness_threshold",
         "threshold": 170, "saturation_threshold": 50 }
}
```

### Decision rules (`rules`)

Each rule is evaluated by `DecisionEngine` after every normalizer event.

```jsonc
{
  "id": "health_critical",           // unique string ID
  "trigger": "health.change",        // EVENT_TYPES value that activates this rule
  "condition": {                     // optional — omit to fire on every trigger
    "payload.current": { "$lte": 25 }
  },
  "priority": "critical",            // "critical" | "high" | "medium" | "low"
  "cooldown": 5000,                  // ms between successive firings of this rule
  "confidence": {                    // optional sliding-window gate
    "minSignals": 2,
    "window": 4000                   // ms window; rule only fires if >= minSignals in window
  },
  "context": {                       // optional — boost priority when conditions met
    "under_fire": { "priorityBoost": 1 }
  },
  "supersedes": ["other_rule_id"],   // suppress listed rules when this one fires
  "output": {
    "message": "Critical HP — heal now",
    "ttl": 8000                      // ms to display the alert in the overlay
  }
}
```

**Condition operators**

| Operator | Meaning |
|---|---|
| `$lte` | ≤ |
| `$lt` | < |
| `$gte` | ≥ |
| `$gt` | > |
| `$eq` | = |
| `$ne` | ≠ |
| `$in` | value in array |
| `$nin` | value not in array |

Paths use dot notation into the GameEvent: `payload.current`, `payload.bucket`, etc.

---

## detector.py

Must expose a single function:

```python
def detect(frame: np.ndarray, profile: dict) -> dict:
    ...
```

**`frame`** — a full-resolution BGR frame from `mss` (numpy uint8 array, shape `[H, W, 3]`).

**`profile`** — the parsed `profile.json` dict.

**Return value** — a flat dict with one key per HUD field:

```python
{
    "health":       87,          # int | None
    "credits":      3900,        # int | None
    "phase":        "buy",       # str | None  — canonical string
    "round_number": 12,          # int | None
    "abilities":    {            # dict — one bool per slot
        "Q": True, "E": False, "C": True, "X": False
    },
    "spike_state":  None,        # "planted" | "defused" | "detonated" | None
}
```

Rules:
- Return `None` for a field when it cannot be confidently read this frame.
- Never raise — exceptions must be caught internally and logged; return `None` for that field.
- Keep the module **stateless** — temporal smoothing is applied upstream by `FrameDetector`.

Use `src/services/vision/roi.py` helpers (`crop`, `preprocess_number_crop`,
`preprocess_light_text`, `mean_brightness`, `mean_saturation`) for consistent
preprocessing across profiles.

---

## Canonical phase strings

The normalizer recognises these phase strings from `detector.py`:

| String | Meaning |
|---|---|
| `"buy"` | Buy phase (purchasing window open) |
| `"combat"` | Live round (timer running) |
| `"end_win"` | Round ended — local player's team won |
| `"end_loss"` | Round ended — local player's team lost |

---

## Testing your profile

Use the synthetic profile as a reference for writing tests that require no live
game, Tesseract, or OpenCV installation:

```bash
# Run the vision pipeline tests (synthetic profile, requires only numpy)
python tests/test_vision_pipeline.py

# Test your detector on a real screenshot
python src/services/vision/server.py --test path/to/screenshot.png

# Batch-test a folder of screenshots
python src/services/vision/server.py --replay recordings/
```

For ROI calibration against a real Valorant screenshot, use the interactive tool:

```bash
python tools/calibrate_rois.py --capture
```
