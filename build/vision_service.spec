# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for the GamePartner vision service.

Output: dist/vision_server/  (a folder — not a single file — for faster startup)

Build:
  pyinstaller build/vision_service.spec --distpath dist/

The orchestrator references: dist/vision_server/vision_server.exe
electron-builder copies it to resources/vision/ via extraResources.
"""

import os

# Resolve paths relative to the repo root (one level up from build/)
REPO_ROOT = os.path.abspath(os.path.join(SPECPATH, '..'))
VISION_SRC = os.path.join(REPO_ROOT, 'src', 'services', 'vision')

block_cipher = None

a = Analysis(
    [os.path.join(VISION_SRC, 'server.py')],
    pathex=[VISION_SRC],
    binaries=[],
    datas=[
        # Bundle config so the frozen exe can find it via GP_CONFIG_PATH
        (os.path.join(REPO_ROOT, 'config'), 'config'),
        # Bundle all game profiles (profile.json + detector.py)
        (os.path.join(REPO_ROOT, 'src', 'profiles'), 'profiles'),
    ],
    hiddenimports=[
        'cv2',
        'cv2.cv2',
        'pytesseract',
        'mss',
        'mss.tools',
        'numpy',
        'numpy.core._methods',
        'numpy.lib.format',
        'PIL',
        'PIL.Image',
        'requests',
        'requests.adapters',
        'urllib3',
        'charset_normalizer',
        'certifi',
        'idna',
        # vision service local modules
        'capture',
        'detect',
        'smoothing',
        'roi',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'scipy', 'pandas', 'IPython'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='vision_server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,        # no console window for end users
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='vision_server',
)
