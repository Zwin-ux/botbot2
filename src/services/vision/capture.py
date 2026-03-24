"""
Screen capture module.

Wraps mss for fast, low-overhead screen grabbing on Windows.

Key design choices:
  - Returns BGR numpy arrays (what OpenCV expects natively)
  - Exposes actual capture resolution so downstream ROI scaling works correctly
  - Falls back gracefully when display is unavailable (CI / headless runners)
  - FPS timing is the caller's (server.py) responsibility — this class is stateless
  - Optional window targeting via win32gui: if a window_title is set, capture is
    cropped to that window's bounding box so ROIs work for windowed games
"""

import logging
import numpy as np
from typing import Optional, Tuple

log = logging.getLogger(__name__)

try:
    import mss
    import mss.tools
    _MSS_AVAILABLE = True
except ImportError:
    _MSS_AVAILABLE = False
    log.warning("mss not installed — capture returns None. Run: pip install mss")

try:
    import cv2
    _CV2_AVAILABLE = True
except ImportError:
    _CV2_AVAILABLE = False

# ── Window detection (Windows only) ──────────────────────────────────────────
_WIN32_AVAILABLE = False
try:
    import ctypes
    import ctypes.wintypes

    _user32 = ctypes.windll.user32
    _WIN32_AVAILABLE = True
except Exception:
    pass


def find_window_rect(title_substring: str) -> Optional[Tuple[int, int, int, int]]:
    """
    Find a visible window whose title contains `title_substring` (case-insensitive).

    Returns (left, top, width, height) in screen-space, or None if not found.
    Uses the Win32 API directly via ctypes — no pywin32 dependency needed.
    """
    if not _WIN32_AVAILABLE:
        return None

    result = [None]

    # EnumWindows callback: check each visible window's title
    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)
    def enum_cb(hwnd, _lparam):
        if not _user32.IsWindowVisible(hwnd):
            return True  # continue
        length = _user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        _user32.GetWindowTextW(hwnd, buf, length + 1)
        if title_substring.lower() in buf.value.lower():
            rect = ctypes.wintypes.RECT()
            _user32.GetWindowRect(hwnd, ctypes.byref(rect))
            w = rect.right - rect.left
            h = rect.bottom - rect.top
            if w > 50 and h > 50:  # skip tiny/minimized windows
                result[0] = (rect.left, rect.top, w, h)
                return False  # stop enumeration
        return True

    try:
        _user32.EnumWindows(enum_cb, 0)
    except Exception as e:
        log.debug(f"[capture] Window search failed: {e}")

    return result[0]


# Frame metadata returned alongside the pixel data
FrameMeta = dict  # { "width": int, "height": int, "ts_ms": int, "monitor": int }


class ScreenCapture:
    """
    Grabs the primary monitor (or a named monitor by index).
    Optionally targets a specific window by title for windowed games.

    Args:
        monitor_index: 1 = primary. 0 = "all monitors combined" (mss convention).
        window_title: If set, capture is cropped to this window's bounding box.
    """

    def __init__(self, monitor_index: int = 1, window_title: Optional[str] = None):
        self._sct: Optional[object] = None
        self._monitor: Optional[dict] = None
        self._monitor_index = monitor_index
        self._window_title = window_title
        self._window_rect: Optional[Tuple[int, int, int, int]] = None

        if not _MSS_AVAILABLE:
            return

        try:
            self._sct = mss.mss()
            monitors = self._sct.monitors
            idx = monitor_index if monitor_index < len(monitors) else 1
            self._monitor = monitors[idx]
            log.info(
                f"[capture] Monitor {idx}: "
                f"{self._monitor['width']}×{self._monitor['height']} "
                f"at ({self._monitor['left']}, {self._monitor['top']})"
            )
        except Exception as e:
            log.error(f"[capture] Failed to initialise mss: {e}")

        if self._window_title:
            log.info(f"[capture] Window targeting enabled: '{self._window_title}'")

    # ── Public API ────────────────────────────────────────────────────────────

    @property
    def resolution(self) -> Tuple[int, int]:
        """Actual capture resolution (width, height). (0, 0) when unavailable."""
        if self._monitor is None:
            return (0, 0)
        return (self._monitor["width"], self._monitor["height"])

    def grab(self) -> Tuple[Optional[np.ndarray], FrameMeta]:
        """
        Capture the game area.

        If window_title is set, finds and captures only that window's region.
        Otherwise captures the full primary monitor.

        Returns:
            (frame, meta) where frame is a BGR uint8 ndarray, or (None, meta) on failure.
        """
        if not _MSS_AVAILABLE or self._sct is None or self._monitor is None:
            return None, self._empty_meta()

        # Window targeting: find the game window and capture only its region
        if self._window_title:
            rect = find_window_rect(self._window_title)
            if rect is not None:
                left, top, w, h = rect
                self._window_rect = rect
                region = {"left": left, "top": top, "width": w, "height": h}
                return self._grab_monitor(region)
            else:
                # Window not found — fall back to full monitor
                if self._window_rect is None:
                    log.debug(f"[capture] Window '{self._window_title}' not found — full monitor")
                return self._grab_monitor(self._monitor)

        return self._grab_monitor(self._monitor)

    def grab_region(self, x: int, y: int, w: int, h: int) -> Tuple[Optional[np.ndarray], FrameMeta]:
        """
        Capture a sub-region of the primary monitor.

        Coordinates are in screen-space (relative to the monitor's top-left).
        """
        if not _MSS_AVAILABLE or self._sct is None:
            return None, self._empty_meta()
        region = {
            "left":   self._monitor["left"] + x,
            "top":    self._monitor["top"]  + y,
            "width":  w,
            "height": h,
        }
        return self._grab_monitor(region)

    def load_file(self, path: str) -> Tuple[Optional[np.ndarray], FrameMeta]:
        """
        Load a screenshot from disk (used in --test / replay mode).
        Returns a BGR frame + synthetic meta with the image dimensions.
        """
        if not _CV2_AVAILABLE:
            log.error("[capture] cv2 not available — cannot load file")
            return None, self._empty_meta()
        frame = cv2.imread(path)
        if frame is None:
            log.error(f"[capture] Could not read file: {path}")
            return None, self._empty_meta()
        h, w = frame.shape[:2]
        import time
        meta: FrameMeta = {
            "width": w, "height": h,
            "ts_ms": int(time.time() * 1000),
            "monitor": 0,
            "source": path,
        }
        log.info(f"[capture] Loaded {path} ({w}×{h})")
        return frame, meta

    # ── Private ───────────────────────────────────────────────────────────────

    def _grab_monitor(self, monitor: dict) -> Tuple[Optional[np.ndarray], FrameMeta]:
        import time
        try:
            raw = self._sct.grab(monitor)
            # mss returns BGRA — drop alpha, keep BGR (OpenCV native format)
            frame = np.array(raw)[:, :, :3]
            meta: FrameMeta = {
                "width":   raw.width,
                "height":  raw.height,
                "ts_ms":   int(time.time() * 1000),
                "monitor": self._monitor_index,
            }
            return frame, meta
        except Exception as e:
            log.error(f"[capture] Grab failed: {e}")
            return None, self._empty_meta()

    @staticmethod
    def _empty_meta() -> FrameMeta:
        import time
        return {"width": 0, "height": 0, "ts_ms": int(time.time() * 1000), "monitor": -1}
