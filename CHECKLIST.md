# GamePartner — GitHub Readiness Checklist

Track progress toward a clean, presentable public repository.
Check items off as completed. Sections are ordered by priority.

---

## 🔴 Blocking — Must complete before pushing

- [x] `.gitignore` — node_modules, __pycache__, data/, logs/, .env
- [x] `README.md` — setup, architecture, usage, profile authoring guide
- [x] No hardcoded secrets or API keys in any file
- [x] No absolute user paths (e.g. `C:\Users\<name>`) in committed code
- [x] `tests/test_normalizer.js` passes cleanly (`node tests/test_normalizer.js`)
- [x] Vision service test mode works (`python src/services/vision/server.py --test`)
- [ ] Verify `npm install && npm start` works on a clean clone (no hidden deps)
- [ ] Verify `pip install -r src/services/vision/requirements.txt` completes cleanly
- [x] `LICENSE` file present (MIT)

---

## 🟡 High priority — Complete before sharing the link

### Repository hygiene
- [x] `LICENSE` file present at project root (MIT)
- [x] Confirm `package.json` `name`, `version`, `description` are accurate
- [ ] Remove any leftover debug `console.log` / `print` statements
- [ ] Audit all `TODO` / `FIXME` / `STUB` comments — either resolve or file as issues

### Functional gaps
- [ ] **Kill feed OCR** — `src/profiles/valorant/detector.py` `_read_kill_feed()`
      is not yet implemented; returns empty list every frame
- [ ] **Spike state detection** — `hud.spikeState` uses `multi_template` but
      template images (`assets/spike_*.png`) do not exist; field always returns null
- [x] **Round end detection** — `round.end` event now emitted for `end_win`/`end_loss` phase transitions
- [x] **Phase `template_match`** → changed `method` to `ocr_keyword`; no longer requires template images

### Calibration
- [ ] **Calibrate health ROI** against a real Valorant screenshot
- [ ] **Calibrate credits ROI** (visible only during buy phase)
- [ ] **Calibrate round number ROI**
- [ ] **Calibrate phase ROI**
- [ ] **Calibrate all 4 ability slots** (C, Q, E, X) — tune brightness + saturation thresholds
- [ ] Update `profile.json` `version` to `3.0.0` once ROIs are confirmed

### Documentation
- [x] Add `src/profiles/README.md` — profile authoring spec (HUD methods, rule schema, canonical phase strings)
- [x] Add `docs/adding-a-game.md` — step-by-step new game profile guide

---

## 🟢 Nice-to-have — Polish before wider sharing

### Demo assets
- [ ] Add `assets/demo.gif` or `assets/screenshot.png` showing the overlay in action
- [ ] Update `README.md` to embed the demo image at the top

### Packaging
- [ ] Test `npm run build` produces a working `.exe` installer
- [ ] Verify Tesseract path auto-detection works after NSIS install
- [ ] Bundle Python vision service into the Electron package
      (`package.json` `extraResources` already configured — verify it works)
- [ ] Add `scripts/setup.bat` for one-click Windows setup

### CI / Automation
- [x] `.github/workflows/test.yml` — runs `node tests/test_normalizer.js` and Python vision tests on every push
- [ ] Add `.github/workflows/lint.yml` — ESLint for JS, flake8 for Python

### Multi-game
- [x] Define `src/profiles/README.md` — spec for what a valid profile must contain
- [x] Add Minesweeper game profile — proves the architecture is generic with a simpler game

### Overlay UX
- [ ] Add position drag (click-and-drag overlay to reposition)
- [ ] Add opacity slider in tray menu
- [ ] Add "click-through" toggle in tray menu (already in config, needs tray wiring)

---

## 📋 Known issues to file as GitHub Issues after push

| Issue | Location | Severity | Status |
|---|---|---|---|
| Arrow key nudge in calibrator may not work on some Windows OpenCV builds | `tools/calibrate_rois.py` | Low | Open |
| Kill feed OCR stub always returns `[]` | `detector.py` | Medium | Open |
| Spike state detection needs template images | `detector.py`, `assets/` | Medium | Open |
| Electron `nativeImage.createEmpty()` used for tray — replace with real icon | `launcher/main.js` | Low | Open |
| ~~`phase` method is `template_match` but templates not shipped~~ | `profile.json` | Medium | **Fixed** |
| ~~`buy_phase_save` rule checks `payload.amount` but `BUY_PHASE` event payload sends `credits`~~ | `profile.json` | High | **Fixed** (field is `payload.credits`) |
| ~~`round.end` event never emitted~~ | `normalizer.js` | Medium | **Fixed** |
| ~~`prevState` in spike event captured after state mutation~~ | `normalizer.js` | Low | **Fixed** |

---

## 🚀 Suggested first GitHub issues to open

1. **[enhancement] Implement kill feed OCR** — `detector.py::_read_kill_feed()`
2. **[enhancement] Ship spike state template images or switch to contour detection**
3. **[enhancement] Calibrate default Valorant ROIs and update profile.json**
4. **[docs] Add calibration walkthrough with screenshots**

---

## Git workflow suggestion

```bash
# Initial push
git init
git remote add origin https://github.com/Zwin-ux/botbot2.git
git add .
git commit -m "feat: initial GamePartner MVP — launcher, vision, agent, overlay"
git branch -M main
git push -u origin main

# Then for each checklist item above:
git checkout -b fix/<issue-name>
# ... work ...
git commit -m "fix: <description>"
git push origin fix/<issue-name>
# Open PR
```
