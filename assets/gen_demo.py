"""
GamePartner demo screenshot generator — NES-accurate overlay mockup.

Produces assets/demo.png — a pixel-art mockup of the overlay showing
GamePartner reading a Minesweeper game, with the HP bar, alerts, and
status indicators all filled in.

Run: python assets/gen_demo.py
"""

import os
import struct
import zlib

import numpy as np

# ── NES palette ──────────────────────────────────────────────────────────────

P = {
    'bg':     (  6,   8,  48),
    'panel':  ( 16,  16,  92),
    'panel2': ( 26,  26, 128),
    'white':  (248, 248, 248),
    'gold':   (248, 192,  56),
    'green':  ( 56, 200,  64),
    'red':    (232,  48,  48),
    'orange': (252, 120,  72),
    'cyan':   ( 60, 188, 252),
    'gray':   (152, 152, 200),
    'dark':   ( 64,  64, 104),
    'dim':    ( 56,  56, 124),
    'crit_bg':( 28,   8,   8),
}

# Canvas: 80 x 50 pixels (will be scaled 4x → 320x200, same as actual overlay)
W, H = 80, 50
SCALE = 4

img = np.full((H, W, 3), P['bg'], dtype=np.uint8)


def rect(r1, c1, r2, c2, col):
    img[max(0,r1):min(H,r2+1), max(0,c1):min(W,c2+1)] = col

def hline(r, c1, c2, col):
    if 0 <= r < H:
        img[r, max(0,c1):min(W,c2+1)] = col

def pixel(r, c, col):
    if 0 <= r < H and 0 <= c < W:
        img[r, c] = col

def text_px(r, c, text, col):
    """Place text as simple block characters (3px wide + 1px gap per char)."""
    # Simplified block font - just fills rectangles for each char
    for i, ch in enumerate(text):
        x = c + i * 4
        if ch == ' ':
            continue
        # Each char is a 3x5 block (simplified)
        for dy in range(5):
            for dx in range(3):
                pixel(r + dy, x + dx, col)


# ── Outer NES double-border ──────────────────────────────────────────────────

rect(0, 0, H-1, W-1, P['panel'])          # fill
hline(0, 0, W-1, P['white'])              # top border
hline(H-1, 0, W-1, P['white'])            # bottom border
for r in range(H):                          # left + right border
    pixel(r, 0, P['white'])
    pixel(r, W-1, P['white'])

# Outer shadow line
hline(2, 2, W-3, P['white'])
hline(H-3, 2, W-3, P['white'])
for r in range(2, H-2):
    pixel(r, 2, P['white'])
    pixel(r, W-3, P['white'])

# ── Header bar ───────────────────────────────────────────────────────────────

rect(3, 3, 10, W-4, P['panel2'])
hline(11, 3, W-4, P['white'])

# Connection dot (green = live)
rect(5, 5, 7, 7, P['green'])

# "GP" brand text (gold, simplified)
for dy in range(5):
    for dx in range(3):
        pixel(5 + dy, 10 + dx, P['gold'])
    for dx in range(3):
        pixel(5 + dy, 14 + dx, P['gold'])

# MINES label (dark, 3px chars)
x = 22
for dx in range(3):
    pixel(6, x + dx, P['dark'])
    pixel(7, x + dx, P['dark'])

# HP bar — 10 segments showing 7/10 (Minesweeper: 7 mines remaining)
hp_x = 27
for i in range(10):
    sx = hp_x + i * 5
    if i < 7:
        rect(5, sx, 8, sx + 3, P['green'])
    else:
        rect(5, sx, 8, sx + 3, P['dim'])

# HP number "7"
pixel(5, hp_x + 53, P['gray'])
pixel(6, hp_x + 53, P['gray'])
pixel(7, hp_x + 53, P['gray'])

# ── Alert feed ───────────────────────────────────────────────────────────────

# Alert 1 (medium priority — gold border): "ALMOST DONE -- SCAN EDGES"
alert_y = 13
rect(alert_y, 3, alert_y + 7, W-4, P['panel'])
# Gold left border
for dy in range(8):
    pixel(alert_y + dy, 3, P['gold'])
    pixel(alert_y + dy, 4, P['gold'])
# Alert prefix "!"
pixel(alert_y + 2, 7, P['gold'])
pixel(alert_y + 3, 7, P['gold'])
pixel(alert_y + 5, 7, P['gold'])
# Alert text approximation (gray blocks)
for dx in range(0, 55, 4):
    for dy in range(2, 6):
        if dx + 10 < W - 6:
            pixel(alert_y + dy, 10 + dx, P['gray'])
            pixel(alert_y + dy, 11 + dx, P['gray'])

# Separator line
hline(alert_y + 8, 3, W-4, P['dim'])

# Alert 2 (info priority — dim border): "SPEED RUN PACE -- NICE"
alert_y2 = alert_y + 9
rect(alert_y2, 3, alert_y2 + 7, W-4, P['panel'])
# Dim left border
for dy in range(8):
    pixel(alert_y2 + dy, 3, P['dim'])
    pixel(alert_y2 + dy, 4, P['dim'])
# Dim text blocks
for dx in range(0, 40, 4):
    for dy in range(2, 6):
        if dx + 10 < W - 6:
            pixel(alert_y2 + dy, 10 + dx, P['dark'])
            pixel(alert_y2 + dy, 11 + dx, P['dark'])

# ── Phase bar ────────────────────────────────────────────────────────────────

phase_y = 33
rect(phase_y, 3, phase_y + 4, W-4, P['panel2'])
hline(phase_y, 3, W-4, P['dim'])
# "PLAYING" text blocks
for dx in range(0, 28, 4):
    pixel(phase_y + 2, 8 + dx, P['dark'])
    pixel(phase_y + 3, 8 + dx, P['dark'])

# ── Status bar (bottom) ─────────────────────────────────────────────────────

status_y = 39
rect(status_y, 3, H-4, W-4, P['bg'])
hline(status_y, 3, W-4, P['dim'])

# Status dot (green = LIVE)
rect(status_y + 2, 5, status_y + 3, 6, P['green'])

# "LIVE" text
for dx in range(0, 12, 4):
    pixel(status_y + 2, 9 + dx, P['dark'])
    pixel(status_y + 3, 9 + dx, P['dark'])

# ── Scanline overlay effect ──────────────────────────────────────────────────
# Every other row gets slightly darker (NES CRT simulation)
for r in range(0, H, 2):
    for c in range(W):
        pixel_val = img[r, c].astype(np.int16)
        darkened = np.clip(pixel_val - 8, 0, 255).astype(np.uint8)
        img[r, c] = darkened


# ── Scale up 4× ─────────────────────────────────────────────────────────────

out = np.repeat(np.repeat(img, SCALE, axis=0), SCALE, axis=1)


# ── Write PNG ────────────────────────────────────────────────────────────────

def write_png(path, pixels):
    h, w = pixels.shape[:2]
    raw = b''.join(b'\x00' + pixels[r].tobytes() for r in range(h))
    compressed = zlib.compress(raw, 9)

    def chunk(ct, data):
        payload = ct + data
        return (struct.pack('>I', len(data))
                + payload
                + struct.pack('>I', zlib.crc32(payload) & 0xFFFFFFFF))

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)

    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', ihdr))
        f.write(chunk(b'IDAT', compressed))
        f.write(chunk(b'IEND', b''))


out_path = os.path.join(os.path.dirname(__file__), 'demo.png')
write_png(out_path, out)
print(f'Demo saved: {out.shape[1]}x{out.shape[0]}px -> {out_path}')
