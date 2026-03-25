'use strict';

/**
 * IPC channel name constants.
 * Single source of truth — required by both main.js and preload.js.
 * Never use string literals for channel names anywhere else.
 */
const IPC = {
  // ── App state ──────────────────────────────────────────────────────────────
  IS_PACKAGED:    'app:isPackaged',
  GET_RESOLUTION: 'app:getResolution',   // → { width, height } of primary display
  OPEN_EXTERNAL:  'app:openExternal',    // open https:// URL in system browser

  // ── Onboarding: checks ─────────────────────────────────────────────────────
  CHECK_DEPS:        'onboarding:checkDeps',
  CHECK_TESSERACT:   'onboarding:checkTesseract',

  // ── Onboarding: installs ───────────────────────────────────────────────────
  INSTALL_TESSERACT: 'onboarding:installTesseract',
  INSTALL_PIPS:      'onboarding:installPips',

  // ── Onboarding: config ─────────────────────────────────────────────────────
  SET_PROFILE:       'onboarding:setProfile',
  SET_RESOLUTION:    'onboarding:setResolution',

  // ── Onboarding: lifecycle ─────────────────────────────────────────────────
  COMPLETE:          'onboarding:complete',
  MINIMIZE:          'onboarding:minimize',
  CLOSE:             'onboarding:close',

  // ── Progress events  (main → renderer, push) ──────────────────────────────
  TESS_PROGRESS:     'tess:progress',
  INSTALL_PROGRESS:  'install:progress',

  // ── Services ───────────────────────────────────────────────────────────────
  SERVICES_STATUS:   'services:status',
  SERVICES_RESTART:  'services:restart',

  // ── Overlay ────────────────────────────────────────────────────────────────
  OVERLAY_TOGGLE:          'overlay:toggle',
  OVERLAY_SET_CLICKTHROUGH:'overlay:setClickThrough',

  // ── Game events (main → overlay renderer, push) ───────────────────────────
  GAME_EVENT: 'gameEvent',
};

// Valid values — used in both main (server-side guard) and preload (client-side guard)
const VALID_GAMES       = ['valorant', 'minesweeper', 'cs2'];
const VALID_RESOLUTIONS = ['1920x1080', '2560x1440', '3840x2160'];

module.exports = { IPC, VALID_GAMES, VALID_RESOLUTIONS };
