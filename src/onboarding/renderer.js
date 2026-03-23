'use strict';

// ── State ─────────────────────────────────────────────────────────────────────

let currentStep  = 0;
let selectedGame = 'valorant';
let selectedRes  = '1920x1080';
let depsChecked  = false;
let isPackaged   = false;

const TOTAL_STEPS = 5;
const STEP_NAMES  = ['STEP 1 OF 5', 'STEP 2 OF 5', 'STEP 3 OF 5', 'STEP 4 OF 5', 'STEP 5 OF 5'];
const NEXT_LABELS = ['[A] Start', '[A] Continue', '[A] Continue', '[A] Continue', '[A] Launch'];

// ── DOM refs ──────────────────────────────────────────────────────────────────

const btnNext  = document.getElementById('btn-next');
const btnBack  = document.getElementById('btn-back');
const segBar   = document.getElementById('seg-bar');
const stepLbl  = document.getElementById('step-label');

// ── Navigation ────────────────────────────────────────────────────────────────

function goTo(n) {
  const next = Math.max(0, Math.min(TOTAL_STEPS - 1, n));

  document.getElementById(`s${currentStep}`)?.classList.remove('active');
  currentStep = next;
  document.getElementById(`s${currentStep}`)?.classList.add('active');

  segBar.querySelectorAll('.seg').forEach((s, i) => s.classList.toggle('on', i <= currentStep));
  stepLbl.textContent  = STEP_NAMES[currentStep];
  btnNext.textContent  = NEXT_LABELS[currentStep];
  btnBack.style.display = currentStep > 0 ? 'inline-block' : 'none';

  if (currentStep === TOTAL_STEPS - 1) {
    btnNext.classList.add('primary');
  } else {
    btnNext.classList.remove('primary');
  }

  // Step entry side-effects
  if (currentStep === 1 && !depsChecked) runSystemCheck();
}

btnNext.addEventListener('click', () => {
  if (currentStep === TOTAL_STEPS - 1) { launch(); return; }
  goTo(currentStep + 1);
});
btnBack.addEventListener('click', () => goTo(currentStep - 1));

// Keyboard navigation
document.addEventListener('keydown', (e) => {
  const k = e.key;

  if (k === 'Enter' || k === 'a' || k === 'A') {
    if (currentStep === TOTAL_STEPS - 1) { launch(); return; }
    goTo(currentStep + 1);
  }
  if ((k === 'b' || k === 'B' || k === 'Escape') && currentStep > 0) {
    goTo(currentStep - 1);
  }

  if (currentStep === 2) {
    const rows = [...document.querySelectorAll('.game-row:not(.off)')];
    const cur  = rows.findIndex(r => r.classList.contains('sel'));
    if (k === 'ArrowDown' && cur < rows.length - 1) selectGame(rows[cur + 1]);
    if (k === 'ArrowUp'   && cur > 0)               selectGame(rows[cur - 1]);
  }

  if (currentStep === 3) {
    const rows = [...document.querySelectorAll('.res-row')];
    const cur  = rows.findIndex(r => r.classList.contains('sel'));
    if (k === 'ArrowDown' && cur < rows.length - 1) selectRes(rows[cur + 1]);
    if (k === 'ArrowUp'   && cur > 0)               selectRes(rows[cur - 1]);
  }
});

// Window controls
document.getElementById('btn-close').addEventListener('click', () => window.gp.close());
document.getElementById('btn-min').addEventListener('click',   () => window.gp.minimize());

// ── System Check (Step 1) ─────────────────────────────────────────────────────

// Checks shown in packaged mode (everything bundled except Tesseract)
const PACKAGED_CHECKS = [
  { id: 'vision',    label: 'Vision Engine'    },
  { id: 'engine',    label: 'Decision Engine'  },
  { id: 'overlay',   label: 'Overlay Renderer' },
  { id: 'tesseract', label: 'Tesseract OCR'    },
];

// Checks shown in dev mode (raw dep check)
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
  depsChecked = true;
  const list   = document.getElementById('check-list');
  const sub    = document.getElementById('check-sub');
  const status = document.getElementById('check-status');
  list.innerHTML = '';

  if (isPackaged) {
    // ── Packaged mode: first three are always bundled, check Tesseract last ──
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
    const tess = await window.gp.checkTesseract();

    if (tess.ok) {
      setCheckRow('tesseract', true, tess.version || 'INSTALLED');
      sub.textContent = 'All components ready.';
      status.textContent = '';
    } else {
      setCheckRow('tesseract', false, 'NOT FOUND');
      sub.textContent = 'Tesseract OCR is required for game detection.';
      status.textContent = 'Required for reading HP and credit values from screen.';
      document.getElementById('tess-area').style.display = 'block';
    }

  } else {
    // ── Dev mode: real dep check ──────────────────────────────────────────────
    for (const c of DEV_CHECKS) list.appendChild(makeCheckRow(c.id, c.label));
    sub.textContent = 'Scanning environment...';

    const results = await window.gp.checkDeps();
    let allOk = true;

    for (const c of DEV_CHECKS) {
      const r  = results[c.key];
      const ok = c.isOk(r);
      if (!ok) allOk = false;
      setCheckRow(c.id, ok, c.detail(r));
    }

    sub.textContent    = allOk ? 'All requirements satisfied.' : 'Some requirements are missing.';
    status.textContent = '';

    if (!results.packages?.allOk) {
      document.getElementById('pip-area').style.display = 'block';
    }
    if (!results.tesseract?.ok) {
      document.getElementById('tess-area').style.display = 'block';
    }
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
  this.disabled = true;
  const prog   = document.getElementById('tess-progress');
  const sub    = document.getElementById('check-sub');
  const status = document.getElementById('check-status');

  const bdg = document.getElementById('cb-tesseract');
  if (bdg) { bdg.className = 'check-badge checking'; bdg.textContent = '[ .... ]'; }

  window.gp.onTessProgress(({ type, pct }) => {
    if (type === 'download') {
      prog.textContent = `DOWNLOADING... ${pct}%`;
    } else if (type === 'installing') {
      prog.textContent = 'INSTALLING TESSERACT OCR...';
    }
  });

  const result = await window.gp.installTesseract();

  if (result.ok) {
    prog.textContent = 'INSTALLATION COMPLETE';
    setCheckRow('tesseract', true, result.version || 'INSTALLED');
    sub.textContent    = 'All components ready.';
    status.textContent = '';
    this.style.display = 'none';
  } else {
    prog.textContent = 'INSTALL FAILED';
    status.textContent = 'Visit: github.com/UB-Mannheim/tesseract to install manually.';
    setCheckRow('tesseract', false, 'MANUAL INSTALL NEEDED');
    this.disabled    = false;
    this.textContent = '&#x25BA; Retry installation';
  }
});

// ── Pip install (dev mode) ────────────────────────────────────────────────────

document.getElementById('btn-install-pips').addEventListener('click', async function () {
  this.disabled = true;
  const prog = document.getElementById('pip-progress');
  let lastMsg = '';

  window.gp.onInstallProgress(({ text }) => {
    if (text && text !== lastMsg) {
      lastMsg = text;
      prog.textContent = text.substring(0, 60).toUpperCase();
    }
  });

  const result = await window.gp.installPips();

  if (result.ok) {
    prog.textContent = 'PACKAGES INSTALLED SUCCESSFULLY';
    this.style.display = 'none';
    depsChecked = false;
    setTimeout(() => runSystemCheck(), 400);
  } else {
    prog.textContent = 'INSTALL FAILED -- RUN pip MANUALLY';
    this.disabled    = false;
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
  selectedGame = row.dataset.game;
  window.gp.setProfile(selectedGame);
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
  selectedRes = row.dataset.res;
  window.gp.setResolution(selectedRes);

  const warn = document.getElementById('res-warning');
  warn.classList.toggle('show', selectedRes !== '1920x1080');
}

document.querySelectorAll('.res-row').forEach(row => {
  row.addEventListener('click', () => selectRes(row));
});

// ── Launch (Step 4) ───────────────────────────────────────────────────────────

async function launch() {
  btnNext.disabled    = true;
  btnNext.textContent = 'LOADING...';
  await window.gp.complete();
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function esc(str) {
  return String(str).replace(/[<>&"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])
  );
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  isPackaged = await window.gp.isPackaged();
  goTo(0);
}

init();
