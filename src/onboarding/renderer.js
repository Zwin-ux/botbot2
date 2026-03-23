'use strict';

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  step:        0,
  game:        'valorant',
  res:         '1920x1080',
  depsChecked: false,
  packaged:    false,
  busy:        false,
};

const TOTAL_STEPS = 5;
const STEP_NAMES  = ['STEP 1 OF 5', 'STEP 2 OF 5', 'STEP 3 OF 5', 'STEP 4 OF 5', 'STEP 5 OF 5'];
const NEXT_LABELS = ['[A] Start', '[A] Continue', '[A] Continue', '[A] Continue', '[A] Launch'];

// ── DOM refs ──────────────────────────────────────────────────────────────────

const btnNext = document.getElementById('btn-next');
const btnBack = document.getElementById('btn-back');
const segBar  = document.getElementById('seg-bar');
const stepLbl = document.getElementById('step-label');

// ── Navigation ────────────────────────────────────────────────────────────────

function goTo(n) {
  if (state.busy) return;
  const next = Math.max(0, Math.min(TOTAL_STEPS - 1, n));

  document.getElementById(`s${state.step}`)?.classList.remove('active');
  state.step = next;
  document.getElementById(`s${state.step}`)?.classList.add('active');

  segBar.querySelectorAll('.seg').forEach((s, i) => s.classList.toggle('on', i <= state.step));
  stepLbl.textContent = STEP_NAMES[state.step];
  btnNext.textContent = NEXT_LABELS[state.step];
  btnNext.classList.toggle('primary', state.step === TOTAL_STEPS - 1);
  btnNext.disabled = false;
  btnBack.style.display = state.step > 0 ? 'inline-block' : 'none';

  if (state.step === 1 && !state.depsChecked) runSystemCheck();
}

btnNext.addEventListener('click', () => {
  if (state.step === TOTAL_STEPS - 1) { launch(); return; }
  goTo(state.step + 1);
});
btnBack.addEventListener('click', () => goTo(state.step - 1));

document.addEventListener('keydown', (e) => {
  const k = e.key;
  if (k === 'Enter' || k === 'a' || k === 'A') {
    if (state.step === TOTAL_STEPS - 1) { launch(); return; }
    goTo(state.step + 1);
  }
  if ((k === 'b' || k === 'B' || k === 'Escape') && state.step > 0) goTo(state.step - 1);

  if (state.step === 2) {
    const rows = [...document.querySelectorAll('.game-row:not(.off)')];
    const cur  = rows.findIndex(r => r.classList.contains('sel'));
    if (k === 'ArrowDown' && cur < rows.length - 1) selectGame(rows[cur + 1]);
    if (k === 'ArrowUp'   && cur > 0)               selectGame(rows[cur - 1]);
  }

  if (state.step === 3) {
    const rows = [...document.querySelectorAll('.res-row')];
    const cur  = rows.findIndex(r => r.classList.contains('sel'));
    if (k === 'ArrowDown' && cur < rows.length - 1) selectRes(rows[cur + 1]);
    if (k === 'ArrowUp'   && cur > 0)               selectRes(rows[cur - 1]);
  }
});

document.getElementById('btn-close').addEventListener('click', () => window.gp.close());
document.getElementById('btn-min').addEventListener('click',   () => window.gp.minimize());

// ── Helpers ───────────────────────────────────────────────────────────────────

function withTimeout(promise, ms = 15000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TIMED OUT')), ms)
    ),
  ]);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function esc(str) {
  return String(str).replace(/[<>&"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])
  );
}

// ── System Check (Step 1) ─────────────────────────────────────────────────────

const PACKAGED_CHECKS = [
  { id: 'vision',    label: 'Vision Engine'    },
  { id: 'engine',    label: 'Decision Engine'  },
  { id: 'overlay',   label: 'Overlay Renderer' },
  { id: 'tesseract', label: 'Tesseract OCR'    },
];

const DEV_CHECKS = [
  {
    key: 'python', id: 'python', label: 'Python 3.x',
    isOk:   r => r.ok,
    detail: r => r.ok ? (r.version || 'OK') : 'NOT FOUND',
  },
  {
    key: 'tesseract', id: 'tesseract', label: 'Tesseract OCR',
    isOk:   r => r.ok,
    detail: r => r.ok ? (r.version || 'INSTALLED') : 'NOT FOUND',
  },
  {
    key: 'packages', id: 'packages', label: 'Vision Packages',
    isOk: r => r.allOk,
    detail: r => r.allOk
      ? 'cv2 / pytesseract / mss'
      : 'MISSING: ' + Object.entries(r.checks || {}).filter(([, v]) => !v.ok).map(([k]) => k).join(', '),
  },
];

async function runSystemCheck() {
  state.depsChecked = true;
  state.busy        = true;
  btnNext.disabled  = true;

  const list   = document.getElementById('check-list');
  const sub    = document.getElementById('check-sub');
  const status = document.getElementById('check-status');
  list.innerHTML = '';

  let allOk = false;

  try {
    if (state.packaged) {
      for (const c of PACKAGED_CHECKS) list.appendChild(makeCheckRow(c.id, c.label));
      sub.textContent = 'Checking components...';

      await sleep(280);
      setCheckRow('vision',  true, 'BUNDLED');
      await sleep(180);
      setCheckRow('engine',  true, 'BUNDLED');
      await sleep(180);
      setCheckRow('overlay', true, 'BUNDLED');
      await sleep(200);

      sub.textContent = 'Checking Tesseract OCR...';
      const tess = await withTimeout(window.gp.checkTesseract());

      if (tess.ok) {
        setCheckRow('tesseract', true, tess.version || 'INSTALLED');
        sub.textContent    = 'All components ready.';
        status.textContent = '';
        allOk = true;
      } else {
        setCheckRow('tesseract', false, 'NOT FOUND');
        sub.textContent    = 'Tesseract OCR is required for game detection.';
        status.textContent = 'Required for reading HP and credit values from screen.';
        document.getElementById('tess-area').style.display = 'block';
      }

    } else {
      for (const c of DEV_CHECKS) list.appendChild(makeCheckRow(c.id, c.label));
      sub.textContent = 'Scanning environment...';

      const results = await withTimeout(window.gp.checkDeps());
      allOk = true;

      for (const c of DEV_CHECKS) {
        const r  = results[c.key];
        const ok = c.isOk(r);
        if (!ok) allOk = false;
        setCheckRow(c.id, ok, c.detail(r));
      }

      sub.textContent    = allOk ? 'All requirements satisfied.' : 'Some requirements are missing.';
      status.textContent = '';

      if (!results.packages?.allOk) document.getElementById('pip-area').style.display  = 'block';
      if (!results.tesseract?.ok)   document.getElementById('tess-area').style.display = 'block';
    }
  } catch (err) {
    sub.textContent    = 'Check failed: ' + err.message;
    status.textContent = 'Click [A] Continue to skip or try again.';
    allOk = false;
  }

  state.busy       = false;
  btnNext.disabled = false;

  if (allOk) {
    await sleep(600);
    if (state.step === 1) goTo(2);
  }
}

function makeCheckRow(id, label) {
  const el = document.createElement('div');
  el.className = 'check-row checking';
  el.id = `cr-${id}`;
  el.innerHTML = `
    <div class="check-icon"></div>
    <div class="check-label">${esc(label)}</div>
    <div class="check-detail" id="cd-${id}">CHECKING...</div>
    <div class="check-badge checking" id="cb-${id}">[ .... ]</div>
  `;
  return el;
}

function setCheckRow(id, ok, detail = '') {
  const row = document.getElementById(`cr-${id}`);
  const det = document.getElementById(`cd-${id}`);
  const bdg = document.getElementById(`cb-${id}`);
  if (!row) return;
  row.classList.remove('checking');
  row.classList.add(ok ? 'ok' : 'fail');
  det.textContent = detail.toUpperCase().substring(0, 26);
  bdg.className   = `check-badge ${ok ? 'ok' : 'fail'}`;
  bdg.textContent = ok ? '[  OK  ]' : '[ FAIL ]';
}

// ── Tesseract auto-install ────────────────────────────────────────────────────

document.getElementById('btn-install-tess').addEventListener('click', async function () {
  if (state.busy) return;
  state.busy    = true;
  this.disabled = true;

  const prog    = document.getElementById('tess-progress');
  const fill    = document.getElementById('tess-fill');
  const sub     = document.getElementById('check-sub');
  const status  = document.getElementById('check-status');
  const manualBtn = document.getElementById('btn-tess-manual');

  const bdg = document.getElementById('cb-tesseract');
  if (bdg) { bdg.className = 'check-badge checking'; bdg.textContent = '[ .... ]'; }

  // Reset fill
  fill.className = 'install-bar-fill';
  fill.style.width = '0%';

  const unsub = window.gp.onTessProgress(({ type, pct }) => {
    if (type === 'download') {
      prog.textContent = `DOWNLOADING... ${pct}%`;
      fill.style.width = `${pct}%`;
    } else if (type === 'installing') {
      prog.textContent = 'INSTALLING TESSERACT OCR...';
      fill.style.width = '95%';
    }
  });

  let result;
  try {
    result = await withTimeout(window.gp.installTesseract(), 150_000);
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  unsub();

  if (result.ok) {
    prog.textContent = 'INSTALLATION COMPLETE';
    fill.className   = 'install-bar-fill done';
    setCheckRow('tesseract', true, result.version || 'INSTALLED');
    sub.textContent    = 'All components ready.';
    status.textContent = '';
    this.style.display = 'none';
    state.busy = false;
    await sleep(600);
    if (state.step === 1) goTo(2);
  } else {
    prog.textContent     = 'INSTALL FAILED';
    fill.className       = 'install-bar-fill error';
    fill.style.width     = '100%';
    status.textContent   = 'Auto-install failed. Download manually below.';
    manualBtn.style.display = 'block';
    setCheckRow('tesseract', false, 'MANUAL INSTALL NEEDED');
    this.disabled    = false;
    this.textContent = '\u25BA Retry installation';
    state.busy = false;
  }
});

document.getElementById('btn-tess-manual').addEventListener('click', () => {
  window.gp.openExternal(
    'https://github.com/UB-Mannheim/tesseract/releases/latest'
  );
});

// ── Pip install (dev mode) ────────────────────────────────────────────────────

document.getElementById('btn-install-pips').addEventListener('click', async function () {
  if (state.busy) return;
  state.busy    = true;
  this.disabled = true;

  const prog = document.getElementById('pip-progress');
  const fill = document.getElementById('pip-fill');
  let lastMsg = '';

  fill.className   = 'install-bar-fill';
  fill.style.width = '10%';

  const unsub = window.gp.onInstallProgress(({ text }) => {
    if (text && text !== lastMsg) {
      lastMsg = text;
      prog.textContent = text.substring(0, 60).toUpperCase();
    }
  });

  let result;
  try {
    result = await withTimeout(window.gp.installPips(), 120_000);
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  unsub();

  if (result.ok) {
    prog.textContent = 'PACKAGES INSTALLED SUCCESSFULLY';
    fill.className   = 'install-bar-fill done';
    this.style.display = 'none';
    state.depsChecked  = false;
    state.busy         = false;
    setTimeout(() => runSystemCheck(), 400);
  } else {
    prog.textContent = 'INSTALL FAILED -- RUN pip MANUALLY';
    fill.className   = 'install-bar-fill error';
    fill.style.width = '100%';
    this.disabled    = false;
    state.busy       = false;
  }
});

// ── Game selection (Step 2) ───────────────────────────────────────────────────

function selectGame(row) {
  document.querySelectorAll('.game-row').forEach(r => {
    r.classList.remove('sel');
    r.querySelector('.game-cur').textContent = '\u00a0';
  });
  row.classList.add('sel');
  row.querySelector('.game-cur').textContent = '\u25BA';
  state.game = row.dataset.game;
  window.gp.setProfile(state.game);
}

document.querySelectorAll('.game-row:not(.off)').forEach(row => {
  row.addEventListener('click', () => selectGame(row));
});

// ── Resolution selection (Step 3) ─────────────────────────────────────────────

function selectRes(row) {
  document.querySelectorAll('.res-row').forEach(r => {
    r.classList.remove('sel');
    r.querySelector('.res-cur').textContent = '\u00a0';
  });
  row.classList.add('sel');
  row.querySelector('.res-cur').textContent = '\u25BA';
  state.res = row.dataset.res;
  window.gp.setResolution(state.res);
  document.getElementById('res-warning').classList.toggle('show', state.res !== '1920x1080');
}

document.querySelectorAll('.res-row').forEach(row => {
  row.addEventListener('click', () => selectRes(row));
});

// ── Launch (Step 4) ───────────────────────────────────────────────────────────

async function launch() {
  if (state.busy) return;
  state.busy          = true;
  btnNext.disabled    = true;
  btnNext.textContent = 'LOADING...';

  let result;
  try {
    result = await withTimeout(window.gp.complete());
  } catch (err) {
    result = { ok: false, error: err.message };
  }

  if (!result.ok) {
    btnNext.disabled    = false;
    btnNext.textContent = '[A] Launch';
    state.busy          = false;
    const status = document.getElementById('check-status');
    if (status) status.textContent = 'STARTUP ERROR: ' + (result.error || 'Unknown error');
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  state.packaged = await window.gp.isPackaged();

  // Auto-detect resolution from primary display
  try {
    const { width, height } = await withTimeout(window.gp.getResolution());
    const detected = `${width}x${height}`;
    const matchRow = document.querySelector(`.res-row[data-res="${detected}"]`);
    if (matchRow) selectRes(matchRow);
  } catch { /* keep 1920x1080 default */ }

  goTo(0);
}

init();
