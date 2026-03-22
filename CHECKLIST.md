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
- [ ] Add `LICENSE` file (MIT recommended — one already referenced in README)

---

## 🟡 High priority — Complete before sharing the link

### Repository hygiene
- [ ] Add `LICENSE` file at project root
- [ ] Confirm `package.json` `name`, `version`, `description` are accurate
- [ ] Remove any leftover debug `console.log` / `print` statements
- [ ] Audit all `TODO` / `FIXME` / `STUB` comments — either resolve or file as issues

### Functional gaps
- [ ] **Kill feed OCR** — `src/profiles/valorant/detector.py` `_read_kill_feed()`
      is not yet implemented; returns empty list every frame
- [ ] **Spike state detection** — `hud.spikeState` uses `multi_template` but
      template images (`assets/spike_*.png`) do not exist; field always returns null
- [ ] **Round end detection** — no event emitted for `round.end` (winner, reason)
- [ ] **Phase `template_match`** → currently falls through to the OCR keyword path;
      either ship the template images or officially change `method` to `ocr_keyword`

### Calibration
- [ ] **Calibrate health ROI** against a real Valorant screenshot
- [ ] **Calibrate credits ROI** (visible only during buy phase)
- [ ] **Calibrate round number ROI**
- [ ] **Calibrate phase ROI**
- [ ] **Calibrate all 4 ability slots** (C, Q, E, X) — tune brightness + saturation thresholds
- [ ] Update `profile.json` `version` to `3.0.0` once ROIs are confirmed

### Documentation
- [ ] Add `docs/calibration.md` — step-by-step screenshot + calibration walkthrough
- [ ] Add `docs/adding-a-game.md` — profile + detector authoring guide

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
- [ ] Add `.github/workflows/test.yml` — runs `node tests/test_normalizer.js`
      on every push (no game or Tesseract needed for this test)
- [ ] Add `.github/workflows/lint.yml` — ESLint for JS, flake8 for Python

### Multi-game
- [ ] Define `src/profiles/README.md` — spec for what a valid profile must contain
- [ ] Stub out a second game profile (e.g. CS2) to prove the architecture is generic

### Overlay UX
- [ ] Add position drag (click-and-drag overlay to reposition)
- [ ] Add opacity slider in tray menu
- [ ] Add "click-through" toggle in tray menu (already in config, needs tray wiring)

---

## 📋 Known issues to file as GitHub Issues after push

| Issue | Location | Severity |
|---|---|---|
| Arrow key nudge in calibrator may not work on some Windows OpenCV builds | `tools/calibrate_rois.py` | Low |
| `phase` method is `template_match` but templates not shipped | `profile.json` | Medium |
| Kill feed OCR stub always returns `[]` | `detector.py` | Medium |
| Spike state detection needs template images | `detector.py`, `assets/` | Medium |
| `buy_phase_save` rule checks `payload.amount` but `BUY_PHASE` event payload sends `credits` | `profile.json`, `normalizer.js` | High |
| Electron `nativeImage.createEmpty()` used for tray — replace with real icon | `launcher/main.js` | Low |

---

## 🚀 Suggested first GitHub issues to open

1. **[enhancement] Implement kill feed OCR** — `detector.py::_read_kill_feed()`
2. **[bug] Fix buy_phase_save rule payload field name** — `payload.credits` not `payload.amount`
3. **[enhancement] Ship spike state template images or switch to contour detection**
4. **[enhancement] Calibrate default Valorant ROIs and update profile.json**
5. **[docs] Add calibration walkthrough with screenshots**

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
