#!/usr/bin/env python3
"""
GamePartner — ROI Calibration Tool
====================================
Interactive tool for tuning HUD element regions in game profiles.
Reads profile.json, overlays all ROIs on a screenshot, and lets you
adjust each one by drawing, nudging, or typing exact values.
Changes are written back to profile.json only when you press S.

Usage
-----
  # Use a saved screenshot (most common)
  python tools/calibrate_rois.py --screenshot path/to/game.png

  # Capture the primary monitor right now
  python tools/calibrate_rois.py --capture

  # Non-default game profile
  python tools/calibrate_rois.py --screenshot game.png --game valorant

Controls
--------
  N / Tab        Next ROI field
  P              Previous ROI field
  E              Edit — draw a new rectangle with the mouse
  T              Test OCR / brightness on selected field
  A              Test ALL fields
  W/S/A/D        Nudge selected ROI 1 px (up/down/left/right)
  Shift+W/S/A/D  Nudge 5 px
  +  /  -        Grow / shrink selected ROI by 2 px each side
  S              Save profile.json
  R              Reset selected ROI to last-saved value
  C              Capture a fresh screenshot (replaces current frame)
  H              Toggle help overlay
  I              Toggle field info panel
  Q / Esc        Quit (warns on unsaved changes)

Dependencies
------------
  opencv-python-headless  (display + selectROI)
  pytesseract             (OCR testing — optional)
  mss                     (live capture — only needed with --capture)
  Tesseract binary        https://github.com/UB-Mannheim/tesseract/wiki
"""

import argparse
import copy
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

import numpy as np

# ── Project path setup ────────────────────────────────────────────────────────
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT / "src" / "services" / "vision"))

# ── Optional imports (graceful degradation) ───────────────────────────────────
try:
    import cv2
except ImportError:
    print("ERROR: opencv-python-headless is required.")
    print("       pip install opencv-python-headless")
    sys.exit(1)

try:
    import pytesseract
    _TESS_EXE = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
    if os.path.isfile(_TESS_EXE):
        pytesseract.pytesseract.tesseract_cmd = _TESS_EXE
    pytesseract.get_tesseract_version()
    _TESS = True
except Exception:
    _TESS = False
    print("WARNING: Tesseract not found — OCR preview will be disabled.")
    print("         Install from https://github.com/UB-Mannheim/tesseract/wiki")

try:
    from roi import (
        preprocess_number_crop,
        preprocess_light_text,
        mean_brightness,
        mean_saturation,
    )
    _ROI_UTILS = True
except ImportError:
    _ROI_UTILS = False


# ── Display constants ─────────────────────────────────────────────────────────

FONT        = cv2.FONT_HERSHEY_SIMPLEX
SIDEBAR_W   = 270      # px — right-side field list panel
ZOOM_H      = 140      # px — bottom zoom strip height
STATUS_H    = 22       # px — status bar at the very bottom
MAX_W       = 1180     # max display width for the screenshot portion

# One BGR colour per logical field group
_COLORS = {
    "health":      ( 50, 210,  50),
    "credits":     ( 50, 215, 215),
    "roundNumber": (215, 215,  50),
    "phase":       (210,  50, 210),
    "killFeed":    (100, 200, 255),
    "ability_Q":   (255, 180,  80),
    "ability_E":   (255, 120,  50),
    "ability_C":   ( 80, 230, 140),
    "ability_X":   ( 50,  50, 245),   # ult — red
    "_default":    (190, 190, 190),
}

_HELP = [
    "N/Tab    next field",
    "P        prev field",
    "E        draw new ROI",
    "T        test OCR",
    "A        test all",
    "WASD     nudge 1 px",
    "Sh+WASD  nudge 5 px",
    "+/-      grow/shrink",
    "S        save",
    "R        reset ROI",
    "C        capture screen",
    "H        toggle help",
    "Q/Esc    quit",
]


# ── Data model ────────────────────────────────────────────────────────────────

@dataclass
class RoiEntry:
    name:       str
    label:      str
    roi:        list          # [x, y, w, h]  ← mutable working copy
    saved_roi:  list          # original value — for reset
    json_path:  list          # path into profile dict, e.g. ["hud","health","roi"]
    color:      tuple
    method:     str  = "ocr_number"
    extra:      dict = field(default_factory=dict)
    last_value: object        = None
    last_conf:  Optional[float] = None
    last_pre:   object        = None   # preprocessed image shown in zoom panel
    dirty:      bool          = False  # differs from saved_roi


def _load_entries(profile: dict) -> List[RoiEntry]:
    """Flatten all HUD ROI definitions from profile.json into a list."""
    entries: List[RoiEntry] = []
    hud = profile.get("hud", {})

    for fname in ("health", "credits", "roundNumber", "phase", "killFeed"):
        cfg = hud.get(fname)
        if not cfg or "roi" not in cfg:
            continue
        roi = list(cfg["roi"])
        entries.append(RoiEntry(
            name=fname, label=fname,
            roi=roi[:], saved_roi=roi[:],
            json_path=["hud", fname, "roi"],
            color=_COLORS.get(fname, _COLORS["_default"]),
            method=cfg.get("method", "ocr_number"),
            extra={"range": cfg.get("range"), "templates": cfg.get("templates")},
        ))

    for slot, cfg in hud.get("abilities", {}).items():
        if "roi" not in cfg:
            continue
        roi = list(cfg["roi"])
        name = f"ability_{slot}"
        entries.append(RoiEntry(
            name=name, label=f"ability {slot}{'  ★' if slot == 'X' else ''}",
            roi=roi[:], saved_roi=roi[:],
            json_path=["hud", "abilities", slot, "roi"],
            color=_COLORS.get(name, _COLORS["_default"]),
            method=cfg.get("method", "brightness_threshold"),
            extra={
                "threshold":           cfg.get("threshold",           155),
                "saturation_threshold": cfg.get("saturation_threshold", 35),
            },
        ))

    return entries


def _save_entries(profile: dict, profile_path: Path, entries: List[RoiEntry]):
    updated = copy.deepcopy(profile)
    for e in entries:
        node = updated
        for key in e.json_path[:-1]:
            node = node[key]
        node[e.json_path[-1]] = e.roi
        e.saved_roi = e.roi[:]
        e.dirty = False
    with open(profile_path, "w", encoding="utf-8") as f:
        json.dump(updated, f, indent=2)
    print(f"[calibrator] Saved → {profile_path}")


# ── OCR / detection testing ───────────────────────────────────────────────────

def _test_entry(frame: np.ndarray, e: RoiEntry):
    """Run detection on e.roi and fill e.last_value / last_conf / last_pre."""
    x, y, w, h = e.roi
    fh, fw = frame.shape[:2]
    if w <= 0 or h <= 0 or x < 0 or y < 0 or x + w > fw or y + h > fh:
        e.last_value = "⚠ ROI out of bounds"
        e.last_conf  = 0.0
        return

    crop_img = frame[y:y+h, x:x+w]

    if e.method == "brightness_threshold":
        if not _ROI_UTILS:
            e.last_value = "roi.py not importable"
            return
        b = mean_brightness(crop_img)
        s = mean_saturation(crop_img)
        thr  = e.extra.get("threshold", 155)
        sthr = e.extra.get("saturation_threshold", 35)
        ready = b > thr and s > sthr
        e.last_value = f"{'✓ READY' if ready else '✗ cooldown'}  B={b:.0f} S={s:.0f}"
        e.last_conf  = None

    elif e.method in ("ocr_number",):
        if not (_TESS and _ROI_UTILS):
            e.last_value = "OCR unavailable"
            return
        pre = preprocess_number_crop(crop_img)
        e.last_pre = pre
        if pre is None:
            e.last_value = None
            e.last_conf  = 0.0
            return
        try:
            cfg = "--psm 8 -c tessedit_char_whitelist=0123456789 --oem 1"
            raw = pytesseract.image_to_string(pre, config=cfg).strip()
            m = re.search(r"\d+", raw)
            if not m:
                e.last_value = "(no digits)"
                return
            val = int(m.group())
            rng = e.extra.get("range")
            if rng:
                lo, hi = rng
                marker = "" if lo <= val <= hi else f"  ⚠ expect {lo}–{hi}"
            else:
                marker = ""
            e.last_value = f"{val}{marker}"
        except Exception as ex:
            e.last_value = f"ERR: {ex}"

    elif e.method == "ocr_killfeed":
        if not (_TESS and _ROI_UTILS):
            e.last_value = "OCR unavailable"
            return
        pre = preprocess_light_text(crop_img)
        e.last_pre = pre
        if pre is None:
            e.last_value = None
            return
        try:
            raw = pytesseract.image_to_string(
                pre, config="--psm 6 --oem 1"
            ).strip()
            e.last_value = f'"{raw[:40]}"' if raw else "(empty)"
        except Exception as ex:
            e.last_value = f"ERR: {ex}"

    elif e.method in ("template_match", "multi_template"):
        e.last_value = "(template — visual check only)"

    else:
        if not (_TESS and _ROI_UTILS):
            e.last_value = "OCR unavailable"
            return
        pre = preprocess_light_text(crop_img)
        e.last_pre = pre
        if pre is None:
            e.last_value = None
            return
        try:
            raw = pytesseract.image_to_string(pre, config="--psm 7 --oem 1").strip()
            e.last_value = f'"{raw[:32]}"' if raw else "(empty)"
        except Exception as ex:
            e.last_value = f"ERR: {ex}"


def _test_all(frame: np.ndarray, entries: List[RoiEntry]):
    for e in entries:
        _test_entry(frame, e)


# ── Drawing ───────────────────────────────────────────────────────────────────

def _draw_main(frame: np.ndarray, entries: List[RoiEntry], sel: int,
               scale: float, show_help: bool) -> np.ndarray:
    dw = int(frame.shape[1] * scale)
    dh = int(frame.shape[0] * scale)
    img = cv2.resize(frame, (dw, dh), interpolation=cv2.INTER_AREA)

    for i, e in enumerate(entries):
        sx, sy, sw, sh = [int(v * scale) for v in e.roi]
        is_sel = (i == sel)
        col    = (255, 255, 255) if is_sel else e.color
        thick  = 2 if is_sel else 1
        cv2.rectangle(img, (sx, sy), (sx + sw, sy + sh), col, thick)

        # Field label above the box
        lbl = e.label + (f":  {e.last_value}" if e.last_value is not None else "")
        ly  = max(sy - 5, 12)
        cv2.putText(img, lbl, (sx + 2, ly), FONT, 0.36, col, 1, cv2.LINE_AA)

        # Corner drag handles for selected ROI
        if is_sel:
            hs = 5
            for cx, cy in [(sx, sy), (sx+sw, sy), (sx, sy+sh), (sx+sw, sy+sh)]:
                cv2.rectangle(img, (cx-hs, cy-hs), (cx+hs, cy+hs), (255, 255, 255), -1)

    if show_help:
        # Semi-transparent help box
        ov = img.copy()
        bw = 172
        bh = len(_HELP) * 15 + 18
        cv2.rectangle(ov, (8, 8), (8 + bw, 8 + bh), (20, 20, 20), -1)
        cv2.addWeighted(ov, 0.72, img, 0.28, 0, img)
        for idx, line in enumerate(_HELP):
            cv2.putText(img, line, (14, 22 + idx * 15), FONT, 0.33,
                        (215, 215, 215), 1, cv2.LINE_AA)

    return img


def _draw_sidebar(entries: List[RoiEntry], sel: int, h: int) -> np.ndarray:
    sb = np.zeros((h, SIDEBAR_W, 3), np.uint8)
    sb[:] = (26, 26, 26)

    cv2.putText(sb, "ROI FIELDS", (10, 18), FONT, 0.42, (170, 170, 170), 1)
    cv2.line(sb, (6, 24), (SIDEBAR_W - 6, 24), (60, 60, 60), 1)

    ROW = 40
    y   = 36
    for i, e in enumerate(entries):
        is_sel = (i == sel)
        if is_sel:
            cv2.rectangle(sb, (4, y - 14), (SIDEBAR_W - 4, y + ROW - 16),
                          (52, 52, 52), -1)

        prefix = "> " if is_sel else "  "
        dirty  = " *" if e.dirty else ""
        tc     = (255, 255, 255) if is_sel else (160, 160, 160)
        cv2.putText(sb, f"{prefix}{e.label}{dirty}", (8, y),
                    FONT, 0.38, tc, 1, cv2.LINE_AA)

        rx, ry, rw, rh = e.roi
        cv2.putText(sb, f"  [{rx},{ry}  {rw}×{rh}]", (8, y + 12),
                    FONT, 0.30, (100, 100, 100), 1, cv2.LINE_AA)

        if e.last_value is not None:
            val_s = str(e.last_value)[:32]
            cv2.putText(sb, f"  {val_s}", (8, y + 23),
                        FONT, 0.30, e.color, 1, cv2.LINE_AA)
        y += ROW

    return sb


def _draw_zoom(frame: np.ndarray, e: RoiEntry, total_w: int) -> np.ndarray:
    panel = np.zeros((ZOOM_H, total_w, 3), np.uint8)
    panel[:] = (16, 16, 16)

    fh, fw = frame.shape[:2]
    x, y, w, h = e.roi

    # — Original crop (left side) —
    x0, y0 = max(x, 0), max(y, 0)
    x1, y1 = min(x + w, fw), min(y + h, fh)
    if x1 > x0 and y1 > y0:
        crop_img = frame[y0:y1, x0:x1]
        max_crop_w = total_w // 3
        sc = min(max_crop_w / max(w, 1), (ZOOM_H - 28) / max(h, 1), 6.0)
        nw = max(1, int((x1 - x0) * sc))
        nh = max(1, int((y1 - y0) * sc))
        zoomed = cv2.resize(crop_img, (nw, nh), interpolation=cv2.INTER_NEAREST)
        oy = (ZOOM_H - 28 - nh) // 2 + 4
        panel[oy:oy+nh, 10:10+nw] = zoomed
        cv2.rectangle(panel, (9, oy-1), (10+nw, oy+nh), (90, 90, 90), 1)
        cv2.putText(panel, "original", (10, ZOOM_H - 6), FONT, 0.28,
                    (90, 90, 90), 1, cv2.LINE_AA)

    # — Preprocessed crop (middle) —
    if e.last_pre is not None:
        pre = e.last_pre
        if len(pre.shape) == 2:
            pre = cv2.cvtColor(pre, cv2.COLOR_GRAY2BGR)
        ph, pw = pre.shape[:2]
        max_pre_w = total_w // 3
        psc = min(max_pre_w / max(pw, 1), (ZOOM_H - 28) / max(ph, 1), 6.0)
        pnw = max(1, int(pw * psc))
        pnh = max(1, int(ph * psc))
        pre_r = cv2.resize(pre, (pnw, pnh), interpolation=cv2.INTER_NEAREST)
        pox = total_w // 3 + 10
        poy = (ZOOM_H - 28 - pnh) // 2 + 4
        panel[poy:poy+pnh, pox:pox+pnw] = pre_r
        cv2.rectangle(panel, (pox-1, poy-1), (pox+pnw, poy+pnh), (60, 60, 60), 1)
        cv2.putText(panel, "preprocessed", (pox, ZOOM_H - 6), FONT, 0.28,
                    (90, 90, 90), 1, cv2.LINE_AA)

    # — Status line —
    info = f"  {e.label}  [{x},{y}  {w}×{h}]"
    cv2.putText(panel, info, (8, ZOOM_H - 18), FONT, 0.33,
                (150, 150, 150), 1, cv2.LINE_AA)
    if e.last_value is not None:
        cv2.putText(panel, f"OCR →  {e.last_value}", (total_w - 320, ZOOM_H - 18),
                    FONT, 0.33, e.color, 1, cv2.LINE_AA)

    return panel


def _compose(frame: np.ndarray, entries: List[RoiEntry], sel: int,
             scale: float, show_help: bool, status: str) -> np.ndarray:
    main_h = int(frame.shape[0] * scale)
    main   = _draw_main(frame, entries, sel, scale, show_help)
    side   = _draw_sidebar(entries, sel, main_h)
    top    = np.hstack([main, side])
    zoom   = _draw_zoom(frame, entries[sel], top.shape[1])
    bar    = np.zeros((STATUS_H, top.shape[1], 3), np.uint8)
    bar[:] = (38, 38, 38)
    cv2.putText(bar, f"  {status}", (4, 15), FONT, 0.36, (190, 190, 190), 1, cv2.LINE_AA)
    return np.vstack([top, zoom, bar])


# ── Calibrator ────────────────────────────────────────────────────────────────

class ROICalibrator:
    WIN = "GamePartner — ROI Calibrator"

    def __init__(self, frame: np.ndarray, profile: dict,
                 profile_path: Path, game: str):
        self.frame        = frame
        self.profile      = profile
        self.profile_path = profile_path
        self.game         = game
        self.entries      = _load_entries(profile)
        self.sel          = 0
        self.show_help    = True
        self.unsaved      = False
        self.scale        = min(1.0, MAX_W / frame.shape[1])
        self.status       = (
            f"Loaded {len(self.entries)} ROIs  |  "
            f"H=help  E=draw  T=test  S=save  Q=quit"
        )
        self._quit_armed  = False   # second Q press exits with unsaved changes

    # ── Main loop ─────────────────────────────────────────────────────────────

    def run(self):
        cv2.namedWindow(self.WIN, cv2.WINDOW_NORMAL)

        print(f"\n[calibrator] {len(self.entries)} ROIs loaded.")
        print(f"[calibrator] Resolution: {self.frame.shape[1]}×{self.frame.shape[0]}")
        if not _TESS:
            print("[calibrator] OCR testing disabled — Tesseract not found.")
        print()

        # Initial test pass so every field has a starting value
        if _TESS and _ROI_UTILS:
            _test_all(self.frame, self.entries)

        while True:
            img = _compose(
                self.frame, self.entries, self.sel,
                self.scale, self.show_help, self.status,
            )
            cv2.imshow(self.WIN, img)
            key = cv2.waitKey(50)

            if key == -1:
                continue

            handled = self._handle_key(key)
            if handled == "quit":
                break

        cv2.destroyAllWindows()

    def _handle_key(self, key: int) -> Optional[str]:
        k = key & 0xFF

        # ── Quit ──────────────────────────────────────────────────────────────
        if k in (ord('q'), 27):
            if self.unsaved and not self._quit_armed:
                self.status = "Unsaved changes!  Press Q again to discard, or S to save."
                self._quit_armed = True
                return None
            return "quit"

        self._quit_armed = False

        # ── Navigation ────────────────────────────────────────────────────────
        if k in (ord('n'), 9):      # Tab
            self.sel = (self.sel + 1) % len(self.entries)
            self._refresh_status()

        elif k == ord('p'):
            self.sel = (self.sel - 1) % len(self.entries)
            self._refresh_status()

        # ── Edit ──────────────────────────────────────────────────────────────
        elif k == ord('e'):
            self._edit_roi()

        # ── Test ──────────────────────────────────────────────────────────────
        elif k == ord('t'):
            e = self.entries[self.sel]
            _test_entry(self.frame, e)
            self.status = f"{e.label}  →  {e.last_value}"

        elif k == ord('a'):
            _test_all(self.frame, self.entries)
            self.status = "Tested all fields"

        # ── Save / reset ──────────────────────────────────────────────────────
        elif k == ord('s'):
            _save_entries(self.profile, self.profile_path, self.entries)
            self.unsaved = False
            self.status  = "✓ Saved"

        elif k == ord('r'):
            e = self.entries[self.sel]
            e.roi   = e.saved_roi[:]
            e.dirty = False
            self.status = f"Reset {e.label}"
            self._refresh_status()

        # ── Capture ───────────────────────────────────────────────────────────
        elif k == ord('c'):
            self._capture_screen()

        # ── Toggles ───────────────────────────────────────────────────────────
        elif k == ord('h'):
            self.show_help = not self.show_help

        # ── Resize ────────────────────────────────────────────────────────────
        elif k in (ord('+'), ord('=')):
            self._resize(2)
        elif k == ord('-'):
            self._resize(-2)

        # ── Nudge: WASD (+ Shift modifier via uppercase) ──────────────────────
        elif k in (ord('w'), ord('W')):
            self._nudge(dy=-(5 if k == ord('W') else 1))
        elif k in (ord('s'), ord('S')):
            # Lowercase 's' is Save — handled above.
            # We only nudge on uppercase S here (Shift+S = nudge down 5px).
            if k == ord('S'):
                self._nudge(dy=5)
        elif k in (ord('a'), ord('A')):
            self._nudge(dx=-(5 if k == ord('A') else 1))
        elif k in (ord('d'), ord('D')):
            self._nudge(dx=(5 if k == ord('D') else 1))

        # ── Arrow keys (Windows raw codes — no 0xFF mask) ────────────────────
        # OpenCV on Windows returns values > 255 for extended keys.
        elif key == 2490368:    self._nudge(dy=-1)  # Up
        elif key == 2621440:    self._nudge(dy=+1)  # Down
        elif key == 2424832:    self._nudge(dx=-1)  # Left
        elif key == 2555904:    self._nudge(dx=+1)  # Right

        return None

    # ── Actions ───────────────────────────────────────────────────────────────

    def _edit_roi(self):
        """Let user draw a new ROI with the mouse using cv2.selectROI."""
        e = self.entries[self.sel]
        self.status = (
            f"Drawing ROI for '{e.label}'  —  "
            "drag to draw, SPACE/ENTER to confirm, C to cancel"
        )
        # Show the scaled screenshot in the main window for drawing
        dw = int(self.frame.shape[1] * self.scale)
        dh = int(self.frame.shape[0] * self.scale)
        scaled = cv2.resize(self.frame, (dw, dh), interpolation=cv2.INTER_AREA)

        # Draw existing ROI so user can see it before replacing
        sx, sy, sw, sh = [int(v * self.scale) for v in e.roi]
        cv2.rectangle(scaled, (sx, sy), (sx+sw, sy+sh), (100, 100, 255), 1)

        cv2.imshow(self.WIN, scaled)
        r = cv2.selectROI(self.WIN, scaled, showCrosshair=True, fromCenter=False)
        x, y, w, h = r

        if w > 0 and h > 0:
            # Convert display coordinates back to original resolution
            rx = int(x / self.scale)
            ry = int(y / self.scale)
            rw = int(w / self.scale)
            rh = int(h / self.scale)
            e.roi     = [rx, ry, rw, rh]
            e.dirty   = True
            self.unsaved = True
            _test_entry(self.frame, e)
            self.status = (
                f"Updated {e.label}: [{rx},{ry}  {rw}×{rh}]"
                + (f"  →  {e.last_value}" if e.last_value is not None else "")
            )
        else:
            self.status = "Edit cancelled"

    def _nudge(self, dx: int = 0, dy: int = 0):
        e = self.entries[self.sel]
        e.roi[0] += dx
        e.roi[1] += dy
        e.dirty      = True
        self.unsaved = True
        self._refresh_status()

    def _resize(self, delta: int):
        e = self.entries[self.sel]
        e.roi[0] -= delta
        e.roi[1] -= delta
        e.roi[2]  = max(4, e.roi[2] + delta * 2)
        e.roi[3]  = max(4, e.roi[3] + delta * 2)
        e.dirty      = True
        self.unsaved = True
        self._refresh_status()

    def _capture_screen(self):
        try:
            import mss
            with mss.mss() as sct:
                mons = sct.monitors
                mon  = mons[1] if len(mons) > 1 else mons[0]
                raw  = sct.grab(mon)
                self.frame = np.array(raw)[:, :, :3]
            h, w = self.frame.shape[:2]
            self.scale = min(1.0, MAX_W / w)
            if _TESS and _ROI_UTILS:
                _test_all(self.frame, self.entries)
            self.status = f"Captured {w}×{h}"
        except Exception as exc:
            self.status = f"Capture failed: {exc}"

    def _refresh_status(self):
        e   = self.entries[self.sel]
        rx, ry, rw, rh = e.roi
        mod = "  [modified]" if e.dirty else ""
        self.status = f"{e.label}  [{rx},{ry}  {rw}×{rh}]{mod}"


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(
        description="GamePartner ROI Calibration Tool",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("--screenshot", metavar="PATH",
                    help="Path to a game screenshot (PNG / JPG)")
    ap.add_argument("--capture", action="store_true",
                    help="Capture the primary monitor on startup")
    ap.add_argument("--game", default="valorant",
                    help="Game profile name (default: valorant)")
    args = ap.parse_args()

    if not args.screenshot and not args.capture:
        ap.print_help()
        print("\nExample:")
        print("  python tools/calibrate_rois.py --screenshot screenshot.png")
        sys.exit(1)

    # Load profile
    profile_path = _ROOT / "src" / "profiles" / args.game / "profile.json"
    if not profile_path.exists():
        print(f"ERROR: Profile not found: {profile_path}")
        sys.exit(1)

    with open(profile_path, encoding="utf-8") as f:
        profile = json.load(f)

    print(f"\n[calibrator] Profile: {profile.get('name', args.game)} "
          f"v{profile.get('version', '?')}")

    # Load / capture frame
    frame: Optional[np.ndarray] = None

    if args.capture:
        try:
            import mss
            with mss.mss() as sct:
                mons = sct.monitors
                mon  = mons[1] if len(mons) > 1 else mons[0]
                raw  = sct.grab(mon)
                frame = np.array(raw)[:, :, :3]
            print(f"[calibrator] Captured: {frame.shape[1]}×{frame.shape[0]}")
        except Exception as e:
            print(f"ERROR: Screen capture failed: {e}")
            sys.exit(1)

    else:
        frame = cv2.imread(args.screenshot)
        if frame is None:
            print(f"ERROR: Could not load screenshot: {args.screenshot}")
            sys.exit(1)
        print(f"[calibrator] Loaded: {args.screenshot} "
              f"({frame.shape[1]}×{frame.shape[0]})")

    # Resolution mismatch warning
    ref_w, ref_h = profile.get("resolution", [1920, 1080])
    act_h, act_w = frame.shape[:2]
    if (act_w, act_h) != (ref_w, ref_h):
        print(f"\nWARNING: Screenshot is {act_w}×{act_h} but profile targets "
              f"{ref_w}×{ref_h}.")
        print("         ROIs may not align. Recapture at the matching resolution,")
        print(f"         or update 'resolution' in profile.json after calibrating.\n")

    ROICalibrator(frame, profile, profile_path, args.game).run()


if __name__ == "__main__":
    main()
