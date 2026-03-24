# GamePartner

<p align="center">
  <img src="assets/sprite.png" width="128" height="128" alt="GamePartner" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-BETA-F8C038?style=flat-square" alt="Beta" />
  <img src="https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-3CBCFC?style=flat-square" alt="Windows" />
  <img src="https://img.shields.io/badge/license-MIT-38C840?style=flat-square" alt="MIT" />
</p>

<p align="center">
  <a href="https://github.com/Zwin-ux/botbot2/releases/latest">
    <img src="https://img.shields.io/badge/Download%20for%20Windows-%E2%AC%87%20GamePartner--Setup.exe-F8C038?style=for-the-badge&logo=windows&logoColor=000000" alt="Download GamePartner" />
  </a>
</p>

<p align="center">
  <strong>Your AI Player 2 &nbsp;&bull;&nbsp; Always available &nbsp;&bull;&nbsp; 100% local</strong>
</p>

---

## Install in 3 steps

1. Click **Download** above and save `GamePartner-Setup.exe`
2. Run it and follow the setup wizard (takes about a minute)
3. Pick your game and hit **Launch** — the overlay appears automatically

> **Windows SmartScreen warning?**
> Click **"More info"** then **"Run anyway"** — the app is safe but unsigned.

---

## What it does

GamePartner watches your screen while you play and shows real-time tips in a small overlay — like having a coach in the corner of your monitor. Drop the EXE and you always have a Player 2.

- Reads your HP, credits, and game phase from the screen (no game files touched)
- Suggests when to save, buy, or use abilities
- Works 100% offline — nothing leaves your PC
- BYOK (Bring Your Own Key) — no subscriptions, no cloud

**Supported games:**
- **Minesweeper** — fully supported (great for testing!)
- **Valorant** — beta support (HP, credits, abilities, phase detection)
- More games coming soon

> **Quick start:** Try Minesweeper first — open Windows Minesweeper, launch GamePartner, and watch the overlay read your mine count and timer in real time.

---

## Overlay controls

| Shortcut | Action |
|---|---|
| `Ctrl + Shift + G` | Show / hide overlay |
| Click & drag overlay | Move it anywhere |
| Right-click tray icon | Settings, restart services, quit |

---

## For developers

```bash
git clone https://github.com/Zwin-ux/botbot2.git
cd botbot2
npm install
pip install -r src/services/vision/requirements.txt
npm start
```

**Build the installer yourself:**
```bash
pip install pyinstaller
npm run dist        # PyInstaller + electron-builder → dist/installer/*.exe
```

**Run tests (no game, no Tesseract needed):**
```bash
npm test            # JS normalizer
npm run test:python # Python vision pipeline (synthetic profile)
```

---

## Architecture

```
Vision (Python :7702)  →  Agent (Node :7701)  →  Overlay (Electron)
                                  ↓
                        Storage (SQLite :7703)
```

Everything runs locally. The Electron launcher manages all services as child processes.
Adding a new game requires only `profile.json` + `detector.py` in `src/profiles/<game>/`.

---

## License

MIT
