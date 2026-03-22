"""
Screen capture module.

Wraps mss for fast, low-overhead screen grabbing on Windows.

Key design choices:
  - Returns BGR numpy arrays (what OpenCV expects natively)
  - Exposes actual capture resolution so downstream ROI scaling works correctly
  - Falls back gracefully when display is unavailable (CI / headless runners)
  - FPS timing is the caller's (server.py) responsibility — this class is stateless
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


# Frame metadata returned alongside the pixel data
FrameMeta = dict  # { "width": int, "height": int, "ts_ms": int, "monitor": int }


class ScreenCapture:
    """
    Grabs the primary monitor (or a named monitor by index).

    Args:
        monitor_index: 1 = primary. 0 = "all monitors combined" (mss convention).
    """

    def __init__(self, monitor_index: int = 1):
        self._sct: Optional[object] = None
        self._monitor: Optional[dict] = None
        self._monitor_index = monitor_index

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

    # ── Public API ────────────────────────────────────────────────────────────

    @property
    def resolution(self) -> Tuple[int, int]:
        """Actual capture resolution (width, height). (0, 0) when unavailable."""
        if self._monitor is None:
            return (0, 0)
        return (self._monitor["width"], self._monitor["height"])

    def grab(self) -> Tuple[Optional[np.ndarray], FrameMeta]:
        """
        Capture the full primary monitor.

        Returns:
            (frame, meta) where frame is a BGR uint8 ndarray, or (None, meta) on failure.
        """
        if not _MSS_AVAILABLE or self._sct is None or self._monitor is None:
            return None, self._empty_meta()
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
