"""
GamePartner sprite generator — NES hardware-accurate palette.

Produces assets/sprite.png (256x256) — a pixel-art eye inside an NES
double-border box, representing the AI watching your game screen.

Requires only stdlib + numpy.
Run: python assets/gen_sprite.py
"""

import os
import struct
import zlib

import numpy as np

# ── NES hardware-accurate colours ────────────────────────────────────────────
# Approximations of NTSC NES PPU output on a typical display.

P = {
    'bg':     ( 6,   8,  48),   # #060830  deep navy
    'gold':   (248, 192,  56),   # #F8C038  $28 yellow — border / cursor
    'panel':  ( 16,  16,  92),   # #10105C  $01 dark panel interior
    'panel2': ( 26,  26, 128),   # $11 slightly lighter panel
    'white':  (248, 248, 248),   # #F8F8F8  $30 near-white
    'cyan':   ( 60, 188, 252),   # #3CBCFC  $21 sky-blue
    'green':  ( 56, 200,  64),   # #38C840  $1A bright green
    'red':    (232,  48,  48),   # #E83030  $06 red
    'orange': (252, 120,  72),   # #FC7848  $17 orange
}

SIZE  = 32   # pixel art resolution
SCALE = 8    # each "pixel" → 8×8 px → 256×256 output

# ── Canvas ────────────────────────────────────────────────────────────────────

img = np.full((SIZE, SIZE, 3), P['bg'], dtype=np.uint8)


def rect(r1, c1, r2, c2, col):
    img[r1:r2 + 1, c1:c2 + 1] = col


def hline(r, c1, c2, col):
    img[r, c1:c2 + 1] = col


def vline(c, r1, r2, col):
    img[r1:r2 + 1, c] = col


def pixel(r, c, col):
    img[r, c] = col


# ── NES double-border ─────────────────────────────────────────────────────────
# Outer gold border (2 px), 2 px gap, inner gold border (1 px)

rect(2, 2, 29, 29, P['gold'])    # outer fill (will be overwritten inside)
rect(4, 4, 27, 27, P['bg'])      # outer gap
rect(4, 4, 27, 27, P['gold'])    # inner border ring
rect(5, 5, 26, 26, P['panel2'])  # interior fill
rect(6, 6, 25, 25, P['panel'])   # deeper interior

# ── Status dot (top-left, green = running) ────────────────────────────────────

rect(7, 7, 8, 8, P['green'])

# ── Alert "!" glyph (top-right, gold) ────────────────────────────────────────

for r in (7, 8, 9):
    pixel(r, 23, P['gold'])
pixel(11, 23, P['gold'])

# ── Pixel-art eye (centre) ────────────────────────────────────────────────────
# Represents the AI watching the game screen.
#
# Layout (relative to row 11, col 8):
#   row  0: . # # # # # # # # # # # . .
#   row  1: # # . . . . . . . . . # # .
#   row  2: # . . C C C C C C C C . # .
#   row  3: # . C C C C C C C C C C . #
#   row  4: # . C C W W W W W W C C . #
#   row  5: # . C C W W P P W W C C . #  ← pupil
#   row  6: # . C C W W P P W W C C . #
#   row  7: # . C C W W W W W W C C . #
#   row  8: # . C C C C C C C C C C . #
#   row  9: # . . C C C C C C C C . # .
#  row 10: # # . . . . . . . . . # # .
#  row 11: . # # # # # # # # # # # . .

BR = 11   # eye base row
BC = 8    # eye base col

EYE = [
    "  WWWWWWWWWWW  ",
    " W             W",
    "W   CCCCCCCCC  W",
    "W CCCCCCCCCCCCC ",
    "W CCWWWWWWWWCC  ",
    "W CCWWPPPPWWCC  ",
    "W CCWWPPPPWWCC  ",
    "W CCWWWWWWWWCC  ",
    "W CCCCCCCCCCCCC ",
    "W   CCCCCCCCC  W",
    " W             W",
    "  WWWWWWWWWWW  ",
]

color_map = {
    'W': P['white'],
    'C': P['cyan'],
    'P': P['panel2'],   # dark pupil centre
    ' ': None,
}

for dr, row_str in enumerate(EYE):
    for dc, ch in enumerate(row_str):
        col = color_map.get(ch)
        if col is not None:
            r, c = BR + dr, BC + dc
            if 0 <= r < SIZE and 0 <= c < SIZE:
                img[r, c] = col

# ── Bottom rule line ──────────────────────────────────────────────────────────

hline(24, 7, 24, P['panel2'])
hline(25, 7, 24, P['panel2'])

# ── Bottom status row (HP indicators: green / orange / red) ──────────────────

rect(23, 9,  24,  11, P['green'])
rect(23, 14, 24, 16,  P['orange'])
rect(23, 19, 24, 21,  P['red'])

# ── Scale up 8× ──────────────────────────────────────────────────────────────

out = np.repeat(np.repeat(img, SCALE, axis=0), SCALE, axis=1)

# ── Write PNG (stdlib only) ───────────────────────────────────────────────────

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


out_path = os.path.join(os.path.dirname(__file__), 'sprite.png')
write_png(out_path, out)
print(f'Sprite saved: {out.shape[1]}x{out.shape[0]}px -> {out_path}')
