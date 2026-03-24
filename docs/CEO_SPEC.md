# GamePartner — Consumer Release Spec

**Status:** Developer Beta (v0.1.0-beta)
**Goal:** Consumer-ready v1.0 release
**Date:** 2026-03-24

---

## Executive Summary

GamePartner is a local-first AI gaming companion with solid architecture, 109 passing tests, and working CI/CD. The core pipeline (capture → detect → normalize → decide → overlay) is production-grade. However, **the product is not consumer-ready.** There are 6 blocking issues that will cause the app to fail silently or confuse users on real machines.

This spec defines the work required to go from developer beta to consumer v1.0.

---

## Phase 1: Must Ship (Blocking)

These issues will cause the app to **fail on real consumer machines.** Nothing else matters until these are fixed.

### 1.1 Window Detection
**Problem:** Vision captures the entire monitor. For windowed games (Minesweeper) and even alt-tabbed fullscreen games, ROIs point at wrong pixels. App appears completely broken.

**Solution:** Add `win32gui` window targeting. Profile specifies a window title/class name. Vision service finds that window, gets its position, and offsets all ROIs automatically.

**Files:** `src/services/vision/capture.py`, profile.json (add `window` field)
**Effort:** 2–3 days
**Impact:** Fixes Minesweeper completely. Makes Valorant more robust.

### 1.2 Tesseract Bundling Verification
**Problem:** PyInstaller bundles vision_server.exe but doesn't include Tesseract tessdata. If Tesseract isn't installed system-wide, all OCR returns None.

**Solution:** Either bundle tessdata in the installer, or verify the auto-install flow works end-to-end on a clean machine. Test the full path: fresh Windows → install GamePartner.exe → Tesseract auto-installs → vision reads screen.

**Files:** `build/vision_service.spec`, `src/launcher/orchestrator.js`
**Effort:** 1 day
**Impact:** OCR works out of the box.

### 1.3 Game Switching Without Re-onboarding
**Problem:** To change games, users must delete a hidden file in %APPDATA%. No settings UI exists. This is unacceptable for consumers.

**Solution:** Add a "Switch Game" option to the tray menu that shows a minimal game picker (reuse onboarding game-select step). Persist to `user-config.json`. Restart vision service with new profile.

**Files:** `src/launcher/main.js` (tray menu), new settings flow
**Effort:** 1–2 days
**Impact:** Multi-game UX works.

### 1.4 Service Crash Recovery UX
**Problem:** When vision crashes, overlay shows a red error but user can't do anything about it. Restart is buried in tray right-click menu.

**Solution:** Add a visible "Restart" button in the overlay error state. One click restarts the crashed service.

**Files:** `src/overlay/renderer.js`, `src/overlay/preload.js`, `src/launcher/main.js`
**Effort:** 0.5 days
**Impact:** Users can self-recover without restarting the app.

### 1.5 Validate Full Install Flow on Clean Machine
**Problem:** Nobody has tested: download .exe → install → first launch → onboarding → play game → overlay shows data. On a machine with zero dev tools.

**Solution:** Test on a clean Windows VM or fresh user account. Document every failure. Fix them.

**Effort:** 1 day
**Impact:** Proves the product actually works.

### 1.6 ROI Scaling for Multiple Resolutions
**Problem:** Onboarding offers 1080p/1440p/4K but ROIs only work at 1080p. Users at other resolutions get zero detections.

**Solution:** Check if `FrameDetector` in `detect.py` already scales ROIs (it may). If so, verify it works. If not, implement proportional scaling: `roi_scaled = roi * (actual_res / profile_res)`.

**Files:** `src/services/vision/detect.py`
**Effort:** 0.5–1 day
**Impact:** Works at all resolutions without manual calibration.

---

## Phase 2: Should Ship (High-Priority UX)

These won't cause failure but will determine whether users keep the app or uninstall.

### 2.1 Connection Status in Overlay
Show "Connecting...", "Vision OK", "Waiting for game..." instead of just a red/green dot. Users need to know the app is working even when no alerts are firing.

**Effort:** 0.5 days

### 2.2 Accessible Logs
Add "View Logs" to tray menu that opens the log file in Notepad. Add log path to README troubleshooting section.

**Effort:** 2 hours

### 2.3 README Troubleshooting
Add FAQ section:
- "Nothing is showing up" → Check if game is fullscreen, verify resolution
- "Tesseract install failed" → Manual download link
- "How do I switch games" → Tray menu
- "ROI seems wrong" → Calibration tool instructions

**Effort:** 2 hours

### 2.4 Demo Screenshot/GIF
Capture the overlay running on a real game. Add to README hero section.

**Effort:** 1 hour

### 2.5 Report Bug Link
Add "Report Bug" to tray menu that opens `https://github.com/Zwin-ux/botbot2/issues/new` in browser. Low cost, high value for feedback.

**Effort:** 30 minutes

---

## Phase 3: Nice to Have (Polish)

### 3.1 Valorant Kill Feed OCR
Implement `_read_kill_feed()` — enables combat.kill context escalation for health rules.

**Effort:** 2–3 days

### 3.2 Spike State Detection
Either ship template images or switch to contour-based detection.

**Effort:** 1–2 days

### 3.3 Real Valorant ROI Calibration
Run calibration tool on live Valorant at 1080p. Update profile.json with verified coordinates.

**Effort:** 2–4 hours (requires playing Valorant)

### 3.4 Overlay Drag to Reposition
Already in config (`position`), needs mouse event wiring.

**Effort:** 0.5 days

### 3.5 Opacity/Click-Through Toggles
Config supports these. Wire them to tray menu checkboxes.

**Effort:** 2 hours

### 3.6 BYOK API Integration
The "Bring Your Own Key" model for AI suggestions. Currently rules are static in profile.json. Future: send game state to user's own LLM API for dynamic coaching.

**Effort:** 1–2 weeks (major feature)

---

## Timeline Estimate

| Phase | Items | Effort | Target |
|-------|-------|--------|--------|
| **Phase 1** | 6 blocking issues | 6–8 days | Week 1–2 |
| **Phase 2** | 5 UX items | 1–2 days | Week 2 |
| **Phase 3** | 6 polish items | 5–8 days | Week 3–4 |
| **v1.0 Release** | — | — | **Week 4** |

---

## Success Criteria for v1.0

- [ ] Fresh Windows machine: download → install → play Minesweeper → overlay shows mine count within 60 seconds
- [ ] Switch to Valorant from tray menu without restarting app
- [ ] Vision crash → user clicks "Restart" in overlay → service recovers
- [ ] Works at 1080p and 1440p without manual ROI calibration
- [ ] README has troubleshooting section with 5+ common issues
- [ ] At least 1 demo screenshot in README

---

## Architecture Strengths (Keep These)

- **Local-first** — nothing leaves the PC. This is the moat.
- **Profile system** — adding a game is just 2 files. Scales to any game.
- **Temporal smoothing** — prevents OCR jitter from spamming false alerts.
- **Confidence gates** — multi-signal confirmation before acting. Professional-grade.
- **NES aesthetic** — distinctive, memorable, not generic.
- **109 tests** — CI catches regressions automatically.

---

## What NOT to Do

- **Don't deploy to Railway/cloud.** Local-first is the differentiator.
- **Don't add AI/LLM yet.** Get the vision pipeline bulletproof first.
- **Don't add more games before Minesweeper + Valorant work perfectly.**
- **Don't over-engineer settings.** Tray menu is enough for v1.0.
- **Don't chase anti-cheat compatibility.** Screen capture is external — you're reading pixels like a human.
