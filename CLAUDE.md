# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**GamePartner** is a local-first AI gaming companion. It captures the screen at 2 FPS, runs CV/OCR to extract game state, and surfaces tactical suggestions via an always-on-top Electron overlay. Supports Minesweeper (fully) and Valorant (beta). No cloud dependency — everything runs on localhost.

System requirements: Node.js ≥ 18, Python ≥ 3.10, Tesseract OCR ≥ 5.0 (install separately on Windows — not pip-installable).

## Commands

```bash
# Install dependencies
npm install
pip install -r src/services/vision/requirements.txt

# Run the app
npm start           # Production
npm run dev         # Extra logging

# Build Windows installer (outputs to dist/)
npm run build
npm run pack        # Unpacked build for testing

# Tests (all runnable without a game, Tesseract, or OpenCV)
npm test                        # JS normalizer unit tests
npm run test:python             # Python vision pipeline tests (requires only numpy)
npm run test:all                # Both suites
python src/services/vision/server.py --test screenshot.png     # Test vision on a real screenshot
python src/services/vision/server.py --replay recordings/      # Batch-test a folder of screenshots

# Calibrate ROIs for your screen resolution
python tools/calibrate_rois.py --capture
```

## Onboarding

On first run, `src/launcher/main.js` detects the absence of `{userData}/setup-complete.json` and shows the onboarding wizard (`src/onboarding/`) instead of launching the overlay. The wizard:
1. **Welcome** — feature overview
2. **System Check** — live dep scan (Python, Tesseract, pip packages) via `spawnSync` in main process; one-click pip install via `spawn` with progress streaming
3. **Game Select** — sets active profile
4. **Done** — writes setup flag, closes wizard, starts services + overlay

To re-run setup: delete `{userData}/setup-complete.json`, or pass `--dev` flag.

## Visual Design: NES 8-bit art style

All UI (onboarding wizard + overlay) uses a hardware-accurate NES palette and aesthetic:
- **Palette**: deep navy bg `#060830`, panel `#10105C`, white border `#F8F8F8`, gold cursor `#F8C038`, green `#38C840`, red `#E83030`, cyan `#3CBCFC`
- **Typography**: `'Courier New', monospace`, uppercase, no anti-aliasing (`-webkit-font-smoothing: none`)
- **Borders**: NES double-border via `border: 3px solid` + `box-shadow: 0 0 0 3px {bg}, 0 0 0 6px {border}`
- **Animations**: `steps()` timing function for frame-accurate blink/snap (no smooth easing)
- **Overlay HP bar**: 10 segmented blocks, color-coded green/orange/red
- **Scanlines**: `repeating-linear-gradient` on `body::after`

## Architecture

Four components communicate over localhost:

```
Vision (Python, :7702)  →  Agent (Node.js, :7701)  →  Overlay (Electron)
                                     ↓
                           Storage (Node.js, :7703)
```

**Electron launcher** (`src/launcher/`) spawns all three services as child processes, health-checks them, and routes WebSocket events to the overlay via IPC.

**Vision service** (`src/services/vision/`) runs a 2 FPS capture loop using `mss`, dispatches to a profile-specific `detector.py` (OpenCV + Tesseract), applies temporal smoothing, and POSTs detections to the Agent.

**Agent service** (`src/services/agent/`) receives raw detections, runs them through `EventNormalizer` (confidence gates, delta filtering, phase confirmation) to produce canonical `GameEvent` objects, then through `DecisionEngine` (rule evaluation, priority, cooldown, confidence windows) to produce filtered decisions. Exposes two WebSocket channels: `/events` (all telemetry) and `/decisions` (overlay feed).

**Overlay** (`src/overlay/`) is an always-on-top 320×200 Electron window subscribed to the Agent's `/decisions` channel. Receives events via IPC from the orchestrator.

**Storage service** (`src/services/storage/`) is a SQLite REST API for event persistence — minimal currently, scaffolded for future analytics.

## Game Profile System

Adding a new game requires only two files:

1. `src/profiles/<game>/profile.json` — ROI coordinates + declarative rule definitions
2. `src/profiles/<game>/detector.py` — `detect(frame: np.ndarray, profile: dict) -> dict`

Then set `"activeProfile": "<game>"` in `config/default.json`.

The rule engine in `decision_engine.js` reads rules from `profile.json` — game logic lives in config, not code.

## Key Design Details

- **Temporal smoothers** (`src/services/vision/smoothing.py`): Numeric/Boolean/Text smoothers prevent single bad OCR frames from triggering false alerts.
- **EventNormalizer** (`src/events/normalizer.js`): The most complex file (549 lines). Handles bucket-aware health transitions, phase confirmation buffers, and confidence gates before emitting events.
- **DecisionEngine** (`src/services/agent/decision_engine.js`): Evaluates rules with priority filtering, cooldown suppression, multi-signal confidence windows, context escalation, and conflict resolution (supersedes rules).
- **Ports**: Agent 7701, Vision 7702, Storage 7703 — configured in `config/default.json`.

## Known Gaps (from CHECKLIST.md)

- Kill feed OCR not implemented (`_read_kill_feed()` returns `[]`)
- Spike state detection needs template images (assets not shipped, spikeState HUD entry removed)
- Default Valorant ROIs calibrated for 1920×1080 — needs verification
- Minesweeper ROIs need calibration against actual Microsoft Minesweeper window
