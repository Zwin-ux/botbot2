"""
Temporal smoothers for vision detections.

Why this exists
---------------
OCR runs on compressed, low-res HUD crops at 2 FPS. Individual frames can misread:

  Frame sequence:  87  87  37  87  87   ← the "37" is OCR noise (8 looked like 3)
  Naive output:    87  87  37  87  87   ← one false event per glitch
  Smoothed output: 87  87  87  87  87   ← median over a 5-frame window = 87

For boolean fields (ability ready/not):
  Frame sequence:  T   T   F   T   T   ← single dark frame (screen transition?)
  Naive output:    T   T   F   T   T   ← brief false "not ready"
  Smoothed output: T   T   T   T   T   ← requires 2 consecutive F to flip

Smoothers live in detect.py (FrameDetector), not in detector.py. The raw
detector remains stateless and purely per-frame. This keeps game detectors
simple to write and unit-test.

Classes
-------
  NumericSmoother  — health, credits, round number
  BooleanSmoother  — ability/ult readiness
  TextSmoother     — phase, spike state
"""

from collections import deque
from statistics import median
from typing import Optional, Tuple


class NumericSmoother:
    """
    Robust smoother for numeric OCR fields.

    Algorithm:
      - Keeps last `window` valid (non-None) readings.
      - Returns the median — immune to single outliers.
      - Debounce: if the new smoothed value differs from the last emitted value
        by less than `debounce_delta`, returns the last emitted value unchanged.
        This suppresses 1–2 point OCR jitter (e.g., health reading 87 vs 88
        on the same frame due to sub-pixel antialiasing).

    Confidence = (valid_readings / window) × agreement_ratio
    where agreement_ratio = fraction of readings within ±(debounce_delta * 3) of median.
    """

    def __init__(self, window: int = 5, debounce_delta: int = 3):
        self._window = window
        self._debounce = debounce_delta
        self._buf: deque = deque(maxlen=window)
        self._last: Optional[int] = None

    def update(self, raw: Optional[int]) -> Tuple[Optional[int], float]:
        """
        Feed a new raw reading. Returns (smoothed_value, confidence).

        smoothed_value may be the same as the last emission if the change is
        within debounce_delta (i.e. the value hasn't meaningfully changed).
        Returns (None, 0.0) when the buffer has no data.
        """
        if raw is not None:
            self._buf.append(raw)

        if not self._buf:
            return None, 0.0

        fill_ratio = len(self._buf) / self._window

        med = int(median(self._buf))

        # Measure how many readings agree with the median (within a tolerance)
        # This distinguishes a clean stable signal from a noisy one where the
        # median happens to land correctly despite many outliers.
        tolerance = max(self._debounce * 3, 5)
        agreeing = sum(1 for v in self._buf if abs(v - med) <= tolerance)
        agreement = agreeing / len(self._buf)

        confidence = round(fill_ratio * agreement, 3)

        # Debounce: only update if the change is meaningful
        if self._last is not None and abs(med - self._last) < self._debounce:
            # Return the last stable value with current confidence
            return self._last, confidence

        self._last = med
        return med, confidence

    def reset(self):
        self._buf.clear()
        self._last = None


class BooleanSmoother:
    """
    Hysteresis smoother for boolean detections (ability ready, ult ready).

    Prevents single-frame flickers:
      - Flips to True  only after `true_threshold`  consecutive or majority True reads
      - Flips to False only after `false_threshold` consecutive or majority False reads

    This asymmetry is intentional: missing a "ready" notification for one extra
    frame is better than flickering, so we require more evidence to confirm
    readiness than to confirm cooldown.

    Confidence = fraction of window that matches the current state.
    """

    def __init__(self, window: int = 5, true_threshold: int = 3, false_threshold: int = 2):
        self._window = window
        self._true_thresh = true_threshold
        self._false_thresh = false_threshold
        self._buf: deque = deque(maxlen=window)
        self._state: bool = False

    def update(self, raw: bool) -> Tuple[bool, float]:
        self._buf.append(bool(raw))
        n = len(self._buf)
        true_count  = sum(self._buf)
        false_count = n - true_count

        if not self._state and true_count >= self._true_thresh:
            self._state = True
        elif self._state and false_count >= self._false_thresh:
            self._state = False

        dominant = true_count if self._state else false_count
        confidence = round(dominant / max(n, 1), 3)
        return self._state, confidence

    def reset(self):
        self._buf.clear()
        self._state = False


class TextSmoother:
    """
    Mode-vote smoother for categorical text fields (phase, spike state).

    Returns the most frequent value seen in the window, provided it appears
    at least `min_votes` times. This prevents a single bad OCR frame from
    changing the reported phase.

    Example:
      Readings: ["buy", "buy", "b4y", "buy", None]
      Counts:   {"buy": 3, "b4y": 1}  ← None is ignored
      Result:   ("buy", 0.75)          ← 3 out of 4 valid reads agree
    """

    def __init__(self, window: int = 4, min_votes: int = 2):
        self._window = window
        self._min_votes = min_votes
        self._buf: deque = deque(maxlen=window)

    def update(self, raw: Optional[str]) -> Tuple[Optional[str], float]:
        if raw is not None:
            self._buf.append(raw.strip().lower())

        if not self._buf:
            return None, 0.0

        counts: dict = {}
        for v in self._buf:
            counts[v] = counts.get(v, 0) + 1

        best_val, best_count = max(counts.items(), key=lambda kv: kv[1])

        if best_count < self._min_votes:
            # Not enough agreement yet — emit nothing rather than noise
            return None, round(best_count / len(self._buf), 3)

        confidence = round(best_count / len(self._buf), 3)
        return best_val, confidence

    def reset(self):
        self._buf.clear()


class SmoothingBank:
    """
    Manages a named collection of smoothers for a detection session.

    detect.py creates one SmoothingBank per game session and resets it
    when the session changes.

    Usage:
        bank = SmoothingBank()
        bank.add("health",   NumericSmoother(window=5, debounce_delta=3))
        bank.add("phase",    TextSmoother(window=4, min_votes=2))
        bank.add("ult",      BooleanSmoother(window=5, true_threshold=3))

        smoothed, conf = bank.update("health", raw_value)
    """

    def __init__(self):
        self._smoothers: dict = {}

    def add(self, name: str, smoother):
        self._smoothers[name] = smoother

    def update(self, name: str, raw) -> Tuple[any, float]:
        smoother = self._smoothers.get(name)
        if smoother is None:
            return raw, 1.0  # passthrough if no smoother registered
        return smoother.update(raw)

    def reset_all(self):
        for s in self._smoothers.values():
            s.reset()
