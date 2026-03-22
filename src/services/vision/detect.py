"""
FrameDetector — stateful profile dispatcher.

Responsibilities:
  1. Load the correct detector module for the active game (e.g. valorant/detector.py)
  2. Call it per-frame to get raw (unsmoothed) detections
  3. Apply temporal smoothers to produce stable, confidence-scored outputs
  4. Return a structured detection dict ready for server.py to forward to the agent

Raw detector interface (what each profiles/<game>/detector.py must implement):

    def detect(frame: np.ndarray, profile: dict) -> dict:
        return {
            "health":        int | None,   # 0–100
            "credits":       int | None,   # 0–9000
            "phase":         str | None,   # "buy" | "combat" | "end"
            "round_number":  int | None,
            "abilities": {
                "Q": bool, "E": bool, "C": bool, "X": bool
            },
            "spike_state":   str | None,   # "planted" | "defused" | "detonated"
        }

Structured output from FrameDetector.detect() (what server.py sends to the agent):

    {
        "game":      "valorant",
        "timestamp": 1234567890,      # ms epoch
        "raw": {
            "health":        { "value": 87,     "confidence": 0.91 },
            "credits":       { "value": 3200,   "confidence": 0.95 },
            "phase":         { "value": "buy",  "confidence": 0.88 },
            "round_number":  { "value": 5,      "confidence": 0.80 },
            "abilities": {
                "Q": { "value": True,  "confidence": 0.82 },
                "E": { "value": False, "confidence": 0.90 },
                "C": { "value": True,  "confidence": 0.76 },
                "X": { "value": False, "confidence": 0.60 },
            },
            "spike_state":   { "value": None,  "confidence": 0.0  },
        }
    }
"""

import importlib.util
import json
import logging
import os
import time
from typing import Optional

import numpy as np

from smoothing import BooleanSmoother, NumericSmoother, SmoothingBank, TextSmoother
from roi import scale_roi

log = logging.getLogger(__name__)

# Minimum confidence for a field to be included in the flat payload sent to the agent.
# Below this threshold the reading is treated as "not detected this frame".
MIN_CONFIDENCE = 0.30

# Reference resolution all profile ROIs are authored for
REFERENCE_RES = (1920, 1080)


def _load_profile(game: str) -> dict:
    path = os.path.join(os.path.dirname(__file__), f"../../profiles/{game}/profile.json")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        log.warning(f"[detect] No profile.json for '{game}'")
        return {}


def _load_detector(game: str):
    """
    Dynamically import src/profiles/<game>/detector.py and return its `detect` function.
    Falls back to a stub that returns an empty dict.
    """
    detector_path = os.path.join(
        os.path.dirname(__file__), f"../../profiles/{game}/detector.py"
    )
    try:
        spec = importlib.util.spec_from_file_location(f"{game}_detector", detector_path)
        if spec is None:
            raise ImportError("spec_from_file_location returned None")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        log.info(f"[detect] Loaded detector for '{game}'")
        return mod.detect
    except Exception as e:
        log.warning(f"[detect] Could not load detector for '{game}': {e} — using stub")
        return _stub_detect


def _stub_detect(frame: np.ndarray, profile: dict) -> dict:
    return {
        "health": None, "credits": None, "phase": None,
        "round_number": None, "abilities": {}, "spike_state": None,
    }


class FrameDetector:
    """
    Stateful per-game detection pipeline.

    Create one instance per game/session. Call reset_session() when a new
    match starts so smoothing history doesn't bleed across games.
    """

    def __init__(self, game: str, capture_res: tuple = REFERENCE_RES):
        self.game        = game
        self.capture_res = capture_res
        self.profile     = _load_profile(game)
        self._detect_fn  = _load_detector(game)
        self._bank       = self._build_smoother_bank()
        self._frame_count = 0

    # ── Public API ────────────────────────────────────────────────────────────

    def detect(self, frame: np.ndarray, frame_meta: Optional[dict] = None) -> dict:
        """
        Run one full detection cycle on `frame`.

        Returns the structured detection dict (described in module docstring).
        """
        self._frame_count += 1

        # Scale profile ROIs if the capture resolution differs from the reference.
        # We pass a scaled-profile copy so the detector always sees correct coords.
        profile = self._scale_profile_rois(frame_meta)

        # ── Raw detection (stateless, per-frame) ─────────────────────────────
        try:
            raw = self._detect_fn(frame, profile)
        except Exception as e:
            log.error(f"[detect/{self.game}] detector raised: {e}")
            raw = {}

        # ── Apply smoothers ───────────────────────────────────────────────────
        ts = frame_meta["ts_ms"] if frame_meta else int(time.time() * 1000)

        health_v, health_c = self._bank.update("health",       raw.get("health"))
        credits_v, credits_c = self._bank.update("credits",    raw.get("credits"))
        phase_v, phase_c = self._bank.update("phase",          raw.get("phase"))
        round_v, round_c = self._bank.update("round_number",   raw.get("round_number"))
        spike_v, spike_c = self._bank.update("spike_state",    raw.get("spike_state"))

        abilities = {}
        for slot in ("Q", "E", "C", "X"):
            raw_bool = raw.get("abilities", {}).get(slot)
            if raw_bool is None:
                raw_bool = False
            val, conf = self._bank.update(f"ability_{slot}", raw_bool)
            abilities[slot] = {"value": val, "confidence": conf}

        result = {
            "game":      self.game,
            "timestamp": ts,
            "frame":     self._frame_count,
            "raw": {
                "health":       {"value": health_v,  "confidence": health_c},
                "credits":      {"value": credits_v, "confidence": credits_c},
                "phase":        {"value": phase_v,   "confidence": phase_c},
                "round_number": {"value": round_v,   "confidence": round_c},
                "abilities":    abilities,
                "spike_state":  {"value": spike_v,   "confidence": spike_c},
            },
        }
        return result

    def to_agent_payload(self, structured: dict) -> dict:
        """
        Flatten the structured detection dict into the format the agent normalizer expects.

        Only fields with confidence >= MIN_CONFIDENCE are included.
        Low-confidence fields are sent as None so the normalizer treats them as
        "no reading this frame" rather than stale data.
        """
        r = structured["raw"]

        def val_if_confident(field: str, threshold: float = MIN_CONFIDENCE):
            f = r.get(field, {})
            if f.get("confidence", 0) >= threshold:
                return f.get("value")
            return None

        abilities = {}
        for slot, data in r.get("abilities", {}).items():
            if data.get("confidence", 0) >= MIN_CONFIDENCE:
                abilities[slot] = {"ready": data["value"]}

        return {
            "health":       val_if_confident("health"),
            "healthMax":    100,
            "credits":      val_if_confident("credits"),
            "phase":        val_if_confident("phase"),
            "round_number": val_if_confident("round_number"),
            "abilities":    abilities,
            "spike_state":  val_if_confident("spike_state"),
        }

    def reset_session(self):
        """Call when a new game session starts to clear smoothing history."""
        self._bank.reset_all()
        self._frame_count = 0
        log.info(f"[detect/{self.game}] session reset")

    # ── Private ───────────────────────────────────────────────────────────────

    def _build_smoother_bank(self) -> SmoothingBank:
        bank = SmoothingBank()
        # Health changes by real damage (multi-point jumps); debounce=3 ignores OCR jitter
        bank.add("health",       NumericSmoother(window=5, debounce_delta=3))
        # Credits change in large increments (100–800); debounce=20 handles minor jitter
        bank.add("credits",      NumericSmoother(window=5, debounce_delta=20))
        # Round number only ever increments; debounce=0 catches every real change
        bank.add("round_number", NumericSmoother(window=3, debounce_delta=0))
        # Phase text: stable for 20–30 s at a time; require 2 consistent reads
        bank.add("phase",        TextSmoother(window=4, min_votes=2))
        bank.add("spike_state",  TextSmoother(window=3, min_votes=2))
        # Abilities: require 3 of last 5 True reads before reporting ready
        for slot in ("Q", "E", "C", "X"):
            bank.add(f"ability_{slot}", BooleanSmoother(window=5, true_threshold=3, false_threshold=2))
        return bank

    def _scale_profile_rois(self, frame_meta: Optional[dict]) -> dict:
        """
        Return a copy of the profile with all HUD ROIs scaled to the actual
        capture resolution. If capture res matches the reference, this is a no-op.
        """
        if frame_meta is None:
            return self.profile

        actual_res = (frame_meta.get("width", 0), frame_meta.get("height", 0))
        if actual_res == REFERENCE_RES or actual_res == (0, 0):
            return self.profile

        import copy
        scaled = copy.deepcopy(self.profile)
        hud = scaled.get("hud", {})
        ref = tuple(self.profile.get("resolution", list(REFERENCE_RES)))

        for field, cfg in hud.items():
            if isinstance(cfg, dict) and "roi" in cfg:
                cfg["roi"] = scale_roi(cfg["roi"], ref, actual_res)
            # Ability slots are nested one level deeper
            if field == "abilities":
                for slot_cfg in cfg.values():
                    if "roi" in slot_cfg:
                        slot_cfg["roi"] = scale_roi(slot_cfg["roi"], ref, actual_res)

        return scaled
