# GamePartner — Architecture

## Quick start

```
npm install
pip install -r src/services/vision/requirements.txt
npm start
```

## Folder structure

```
gamepartner/
├── config/
│   └── default.json           # ports, intervals, overlay settings
├── src/
│   ├── launcher/
│   │   ├── main.js            # Electron entry — tray, IPC, window
│   │   ├── orchestrator.js    # Spawns & health-monitors child services
│   │   └── preload.js         # (overlay uses its own preload)
│   ├── events/
│   │   ├── schema.js          # EVENT_TYPES + createEvent()
│   │   └── normalizer.js      # Raw detections → canonical GameEvents
│   ├── services/
│   │   ├── agent/
│   │   │   ├── index.js       # HTTP + WS server (port 7701)
│   │   │   └── core.js        # AgentCore + RuleEngine
│   │   ├── vision/
│   │   │   ├── server.py      # HTTP server (port 7702) + capture loop
│   │   │   ├── capture.py     # mss screen grabber
│   │   │   ├── detect.py      # Profile dispatcher
│   │   │   └── requirements.txt
│   │   └── storage/
│   │       ├── index.js       # HTTP CRUD over SQLite (port 7703)
│   │       └── schema.js      # DB init + WAL mode
│   ├── overlay/
│   │   ├── window.js          # BrowserWindow factory (always-on-top)
│   │   ├── preload.js         # contextBridge → gp.*
│   │   ├── index.html         # Minimal HUD panel
│   │   └── renderer.js        # Event → DOM updates
│   └── profiles/
│       └── valorant/
│           ├── profile.json   # ROI config + rule definitions
│           └── detector.py    # CV/OCR implementation for Valorant
├── scripts/
│   └── build.js               # Pre-build validator + electron-builder
└── data/                      # SQLite DB (auto-created)
```

## Data flow

```
Screen
  │
  ▼
Vision service (Python)
  capture.py  →  detect.py  →  profile/valorant/detector.py
  │
  POST /ingest  (127.0.0.1:7701)
  │
  ▼
Agent service (Node)
  EventNormalizer  →  AgentCore  →  RuleEngine
  │                                     │
  │◄────────────── GameEvents ───────────┘
  │
  WebSocket /events
  │
  ▼
Electron main (orchestrator.js)
  │
  ipcMain → overlayWindow.webContents.send('gameEvent', ...)
  │
  ▼
Overlay renderer (renderer.js)
  DOM updates
```

## Ports

| Service  | Port |
|----------|------|
| Agent    | 7701 |
| Vision   | 7702 |
| Storage  | 7703 |

## Adding a new game profile

1. Create `src/profiles/<game>/profile.json` (copy valorant as template)
2. Create `src/profiles/<game>/detector.py` implementing `detect(frame, profile) -> dict`
3. Set `"activeProfile": "<game>"` in `config/default.json`

## Event types

See `src/events/schema.js` → `EVENT_TYPES` for the full list.
Custom game-specific events can be added to the schema and handled in `normalizer.js`.
