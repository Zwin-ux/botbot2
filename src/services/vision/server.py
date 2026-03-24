"""
Vision service — main process.

Modes:
  Normal:  python server.py
           Runs the capture loop at the configured FPS, posts detections to the
           agent, and serves a debug HTTP server on port 7702.

  Test:    python server.py --test path/to/screenshot.png [--game valorant]
           Loads a static screenshot, runs the detector once, prints structured
           JSON output, then exits. No HTTP server, no agent connection needed.

  Replay:  python server.py --replay path/to/screenshots/ [--fps 2]
           Loops over every .png/.jpg in a directory and prints results.
           Useful for batch-testing ROI calibration against recorded frames.

HTTP endpoints (normal mode only):
  GET /health        → { ok, ts, fps, game, frames_captured }
  GET /frame         → last structured detection result
  GET /session       → { sessionId, game }
  POST /session/reset → reset session UUID and smoother state
"""

import argparse
import json
import logging
import os
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Optional

import requests

# ── sys.path setup ────────────────────────────────────────────────────────────
# We're run from the project root (cwd) but modules live in src/services/vision/.
# Add the vision service directory so `from capture import ...` etc. work.
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)

from capture import ScreenCapture
from detect import FrameDetector

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    stream=sys.stdout,
    level=logging.INFO,
    format="[vision] %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
_CONFIG_PATH = (os.environ.get('GP_CONFIG_PATH')
                or os.path.join(_THIS_DIR, "../../../config/default.json"))
with open(_CONFIG_PATH, encoding="utf-8") as _f:
    CONFIG = json.load(_f)

VISION_PORT  = CONFIG["services"]["vision"]["port"]
AGENT_HOST   = CONFIG["services"]["agent"]["host"]
AGENT_PORT   = CONFIG["services"]["agent"]["port"]
AGENT_INGEST = f"http://{AGENT_HOST}:{AGENT_PORT}/ingest"
ACTIVE_GAME  = CONFIG.get("activeProfile", "valorant")

# FPS: prefer the config key "fps" if present, fall back to captureInterval
_FPS_CFG = CONFIG["services"]["vision"].get("fps")
if _FPS_CFG:
    TARGET_FPS = float(_FPS_CFG)
else:
    TARGET_FPS = 1000 / CONFIG["services"]["vision"].get("captureInterval", 500)

FRAME_BUDGET_S = 1.0 / max(TARGET_FPS, 0.1)

# ── Shared state ──────────────────────────────────────────────────────────────
SESSION_ID    = str(uuid.uuid4())
_state_lock   = threading.Lock()
_last_result  : dict = {}
_frames_total : int  = 0
_agent_ok     : bool = False   # tracks whether last agent POST succeeded


# ── Agent retry logic ─────────────────────────────────────────────────────────

class AgentClient:
    """
    Posts detections to the agent /ingest endpoint with exponential back-off.

    The capture loop never crashes on agent unavailability. Instead it backs off
    from 0.5 s to 16 s, then retries at 16 s intervals until the agent responds.
    This means the vision service starts successfully before the agent is ready,
    and self-heals if the agent restarts.
    """

    def __init__(self, url: str):
        self._url = url
        self._backoff = 0.5          # current wait before next retry
        self._max_backoff = 16.0
        self._next_retry_at = 0.0
        self._consecutive_failures = 0

    def post(self, game: str, session_id: str, detections: dict) -> bool:
        now = time.time()
        if now < self._next_retry_at:
            return False  # still in back-off window

        payload = {
            "game":       game,
            "sessionId":  session_id,
            "detections": detections,
        }
        try:
            resp = requests.post(self._url, json=payload, timeout=0.5)
            if resp.status_code == 200:
                if self._consecutive_failures > 0:
                    log.info(f"[vision] Agent connection restored after {self._consecutive_failures} failures")
                self._consecutive_failures = 0
                self._backoff = 0.5  # reset on success
                return True
            else:
                log.warning(f"[vision] Agent returned {resp.status_code}")
                self._record_failure()
                return False

        except requests.exceptions.ConnectionError:
            # Agent not up yet — silent; log once we've been failing a while
            self._record_failure()
            if self._consecutive_failures == 5:
                log.warning(f"[vision] Agent unreachable at {self._url} — backing off")
            return False

        except requests.exceptions.Timeout:
            log.debug("[vision] Agent POST timed out")
            self._record_failure()
            return False

        except Exception as e:
            log.warning(f"[vision] Agent POST error: {e}")
            self._record_failure()
            return False

    def _record_failure(self):
        self._consecutive_failures += 1
        self._next_retry_at = time.time() + self._backoff
        self._backoff = min(self._backoff * 2, self._max_backoff)


# ── Capture loop ──────────────────────────────────────────────────────────────

def capture_loop(cap: ScreenCapture, detector: FrameDetector, client: AgentClient):
    """
    Main capture-detect-post loop.

    Timing: uses frame budget subtraction to maintain consistent FPS regardless
    of how long detection takes. If detection takes longer than one frame budget,
    the next frame starts immediately (no stacking delay).
    """
    global _frames_total, _last_result, _agent_ok, SESSION_ID

    log.info(f"[vision] Capture loop started — game={ACTIVE_GAME}, {TARGET_FPS:.1f} FPS")

    while True:
        t0 = time.perf_counter()

        try:
            frame, meta = cap.grab()

            if frame is not None:
                structured = detector.detect(frame, meta)
                flat = detector.to_agent_payload(structured)

                # Update shared state for HTTP /frame endpoint
                with _state_lock:
                    _last_result = structured
                    _frames_total += 1

                # Post to agent
                ok = client.post(ACTIVE_GAME, SESSION_ID, flat)
                _agent_ok = ok

        except Exception as e:
            log.error(f"[vision] Capture loop error: {e}", exc_info=True)

        # Sleep for the remainder of the frame budget
        elapsed = time.perf_counter() - t0
        sleep_s = max(0.0, FRAME_BUDGET_S - elapsed)
        time.sleep(sleep_s)


# ── HTTP server ───────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # suppress default per-request access log

    def _json(self, data: dict, code: int = 200):
        body = json.dumps(data, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            with _state_lock:
                frames = _frames_total
            self._json({
                "ok":       True,
                "ts":       int(time.time() * 1000),
                "fps":      TARGET_FPS,
                "game":     ACTIVE_GAME,
                "frames":   frames,
                "agent_ok": _agent_ok,
            })

        elif self.path == "/frame":
            with _state_lock:
                data = dict(_last_result)
            self._json(data if data else {"error": "no frame yet"})

        elif self.path == "/session":
            self._json({"sessionId": SESSION_ID, "game": ACTIVE_GAME})

        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path == "/session/reset":
            global SESSION_ID
            SESSION_ID = str(uuid.uuid4())
            log.info(f"[vision] Session reset → {SESSION_ID}")
            self._json({"sessionId": SESSION_ID})
        else:
            self._json({"error": "not found"}, 404)


# ── Test / replay mode ────────────────────────────────────────────────────────

def run_test(image_path: str, game: str):
    """
    Load a screenshot, run detection once, print structured JSON.
    Exits with code 0 on success, 1 on error.
    """
    log.info(f"[test] Running detector on: {image_path}")

    cap = ScreenCapture()
    frame, meta = cap.load_file(image_path)

    if frame is None:
        log.error("[test] Failed to load image")
        sys.exit(1)

    detector = FrameDetector(game, capture_res=(meta["width"], meta["height"]))
    structured = detector.detect(frame, meta)
    flat = detector.to_agent_payload(structured)

    print("\n── Structured detection ─────────────────────────────────────────")
    print(json.dumps(structured, indent=2, default=str))
    print("\n── Flat payload (sent to agent) ─────────────────────────────────")
    print(json.dumps(flat, indent=2, default=str))
    print()

    # Report any missing deps
    if not _dep_check():
        sys.exit(1)

    sys.exit(0)


def run_replay(directory: str, game: str):
    """
    Run detector on every image in a directory and print a summary table.
    Useful for tuning ROIs and thresholds against a set of recorded frames.
    """
    images = sorted(
        p for p in Path(directory).iterdir()
        if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".bmp")
    )

    if not images:
        log.error(f"[replay] No images found in: {directory}")
        sys.exit(1)

    log.info(f"[replay] Processing {len(images)} images for game={game}")

    cap = ScreenCapture()
    detector: Optional[FrameDetector] = None

    for img_path in images:
        frame, meta = cap.load_file(str(img_path))
        if frame is None:
            print(f"  SKIP  {img_path.name}")
            continue

        if detector is None or (meta["width"], meta["height"]) != detector.capture_res:
            detector = FrameDetector(game, capture_res=(meta["width"], meta["height"]))

        structured = detector.detect(frame, meta)
        r = structured["raw"]

        def fmt(field):
            d = r.get(field, {})
            v, c = d.get("value"), d.get("confidence", 0)
            return f"{v} ({c:.2f})" if v is not None else f"None ({c:.2f})"

        ult = r.get("abilities", {}).get("X", {})
        print(
            f"  {img_path.name:<40} "
            f"HP={fmt('health'):<14} "
            f"Cred={fmt('credits'):<14} "
            f"Phase={fmt('phase'):<16} "
            f"Ult={'Y' if ult.get('value') else 'N'}"
        )


def _dep_check() -> bool:
    ok = True
    try:
        import cv2
    except ImportError:
        log.error("Missing: opencv-python-headless — pip install opencv-python-headless")
        ok = False
    try:
        import pytesseract
        pytesseract.get_tesseract_version()
    except Exception:
        log.error(
            "Missing/broken: pytesseract or Tesseract binary. "
            "Install Tesseract from https://github.com/UB-Mannheim/tesseract/wiki "
            "then: pip install pytesseract"
        )
        ok = False
    try:
        import mss
    except ImportError:
        log.error("Missing: mss — pip install mss")
        ok = False
    return ok


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="GamePartner vision service")
    parser.add_argument("--test",    metavar="IMAGE",  help="Run detector on a single screenshot and exit")
    parser.add_argument("--replay",  metavar="DIR",    help="Run detector on all images in a directory and exit")
    parser.add_argument("--game",    default=ACTIVE_GAME, help=f"Game profile (default: {ACTIVE_GAME})")
    parser.add_argument("--fps",     type=float,       help="Override capture FPS")
    args = parser.parse_args()

    if args.test:
        run_test(args.test, args.game)
        return  # run_test calls sys.exit()

    if args.replay:
        run_replay(args.replay, args.game)
        return

    # ── Normal service mode ───────────────────────────────────────────────────
    global TARGET_FPS, FRAME_BUDGET_S
    if args.fps:
        TARGET_FPS   = args.fps
        FRAME_BUDGET_S = 1.0 / TARGET_FPS

    _dep_check()  # warn but don't abort — partial functionality is better than nothing

    # Load profile to check for window targeting (windowed games)
    from detect import _load_profile
    profile = _load_profile(args.game)
    window_title = profile.get("window", {}).get("title")

    cap      = ScreenCapture(monitor_index=1, window_title=window_title)
    detector = FrameDetector(args.game, capture_res=cap.resolution)
    client   = AgentClient(AGENT_INGEST)

    # Capture loop runs in a daemon thread
    t = threading.Thread(
        target=capture_loop,
        args=(cap, detector, client),
        daemon=True,
        name="capture-loop",
    )
    t.start()

    log.info(f"[vision] HTTP server on 127.0.0.1:{VISION_PORT}")
    server = HTTPServer(("127.0.0.1", VISION_PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("[vision] Shutting down")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
