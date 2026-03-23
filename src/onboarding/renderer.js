'use strict';

// ── State ────────────────────────────────────────────────────────────────────

let currentStep  = 0;
let selectedGame = 'valorant';
let depsChecked  = false;

const TOTAL_STEPS  = 4;
const STEP_LABELS  = ['START', 'CONTINUE', 'CONTINUE', 'LAUNCH'];
const STEP_NAMES   = ['STEP 1 OF 4', 'STEP 2 OF 4', 'STEP 3 OF 4', 'STEP 4 OF 4'];

// ── DOM refs ─────────────────────────────────────────────────────────────────

const btnNext  = document.getElementById('btn-next');
const btnBack  = document.getElementById('btn-back');
const segBar   = document.getElementById('seg-bar');
const stepLbl  = document.getElementById('step-label');
const aKey     = document.getElementById('a-key');

// ── Navigation ────────────────────────────────────────────────────────────────

function goTo(n) {
  const next = Math.max(0, Math.min(TOTAL_STEPS - 1, n));

  // Deactivate current step
  const prevEl = document.getElementById(`s${currentStep}`);
  if (prevEl) prevEl.classList.remove('active');

  currentStep = next;

  // Activate new step
  const nextEl = document.getElementById(`s${currentStep}`);
  if (nextEl) nextEl.classList.add('active');

  // Update footer progress
  const segs = segBar.querySelectorAll('.seg');
  segs.forEach((s, i) => s.classList.toggle('on', i <= currentStep));
  stepLbl.textContent = STEP_NAMES[currentStep];

  // Update buttons
  btnNext.textContent = STEP_LABELS[currentStep];
  btnBack.style.display = currentStep > 0 ? 'inline-block' : 'none';

  if (currentStep === TOTAL_STEPS - 1) {
    btnNext.classList.add('nes-btn-primary');
    aKey.textContent = '[A]';
  }

  // Step-entry side effects
  if (currentStep === 1 && !depsChecked) runDepCheck();
}

btnNext.addEventListener('click', () => {
  if (currentStep === TOTAL_STEPS - 1) { launch(); return; }
  goTo(currentStep + 1);
});
btnBack.addEventListener('click', () => goTo(currentStep - 1));

// Keyboard: arrow keys on game-select step, Enter for next
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === 'a' || e.key === 'A') {
    if (currentStep === TOTAL_STEPS - 1) { launch(); return; }
    goTo(currentStep + 1);
  }
  if ((e.key === 'b' || e.key === 'B' || e.key === 'Escape') && currentStep > 0) {
    goTo(currentStep - 1);
  }
  if (currentStep === 2) {
    const rows = [...document.querySelectorAll('.game-row:not(.off)')];
    const cur  = rows.findIndex(r => r.classList.contains('sel'));
    if (e.key === 'ArrowDown' && cur < rows.length - 1) selectGame(rows[cur + 1]);
    if (e.key === 'ArrowUp'   && cur > 0)               selectGame(rows[cur - 1]);
  }
});

// ── Window controls ───────────────────────────────────────────────────────────

document.getElementById('btn-close').addEventListener('click', () => window.gp.close());
document.getElementById('btn-min').addEventListener('click',   () => window.gp.minimize());

// ── Dep check (Step 1) ────────────────────────────────────────────────────────

const DEP_META = [
  { key: 'python',    label: 'Python 3.x',    icon: null },
  { key: 'tesseract', label: 'Tesseract OCR',  icon: null },
  { key: 'packages',  label: 'Vision Packages', icon: null,
    isOk:    (r) => r.allOk,
    subOk:   ()  => 'cv2 / pytesseract / mss / numpy',
    subFail: (r) => {
      const missing = Object.entries(r.checks)
        .filter(([, v]) => !v.ok).map(([k]) => k).join(', ');
      return `MISSING: ${missing}`;
    },
  },
];

async function runDepCheck() {
  depsChecked = true;

  const list = document.getElementById('dep-list');
  list.innerHTML = '';

  // Render all rows in "checking" state
  for (const meta of DEP_META) {
    list.appendChild(makeDepRow(meta));
  }

  const sub = document.getElementById('check-sub');
  sub.textContent = 'Scanning environment\u2026';

  const results = await window.gp.checkDeps();

  let allOk = true;
  for (const meta of DEP_META) {
    const r    = results[meta.key];
    const isOk = meta.isOk ? meta.isOk(r) : r.ok;
    if (!isOk) allOk = false;

    let detail;
    if (isOk) {
      detail = meta.subOk ? meta.subOk(r) : (r.version || 'OK');
    } else {
      detail = meta.subFail ? meta.subFail(r) : 'NOT FOUND';
    }

    updateDepRow(meta.key, isOk, detail);
  }

  sub.textContent = allOk ? 'All requirements satisfied.' : 'Some requirements are missing.';

  // Show pip-install button only if packages are missing
  if (!results.packages?.allOk) {
    const btn = document.getElementById('btn-install');
    btn.style.display = 'block';
  }
}

function makeDepRow(meta) {
  const el = document.createElement('div');
  el.className = 'dep-row';
  el.id = `dep-${meta.key}`;
  el.innerHTML = `
    <div class="dep-info" style="flex:1;min-width:0;">
      <div class="dep-label" id="dlbl-${meta.key}">${meta.label.toUpperCase()}</div>
      <div class="dep-version" id="dver-${meta.key}">checking<span class="spin-char"></span></div>
    </div>
    <div class="dep-badge checking" id="dbdg-${meta.key}">[ .... ]</div>
  `;
  return el;
}

function updateDepRow(key, ok, detail) {
  const row  = document.getElementById(`dep-${key}`);
  const ver  = document.getElementById(`dver-${key}`);
  const bdg  = document.getElementById(`dbdg-${key}`);
  if (!row) return;

  row.classList.add(ok ? 'ok' : 'fail');
  ver.textContent  = detail.toUpperCase();
  bdg.className    = `dep-badge ${ok ? 'ok' : 'fail'}`;
  bdg.textContent  = ok ? '[  OK  ]' : '[ FAIL ]';
}

// ── Pip install ───────────────────────────────────────────────────────────────

document.getElementById('btn-install').addEventListener('click', async function () {
  this.disabled = true;
  this.classList.add('working');

  const lbl = document.getElementById('install-label');
  lbl.textContent = 'Installing\u2026';

  let lastMsg = '';
  window.gp.onInstallProgress(({ text }) => {
    if (text && text !== lastMsg) {
      lastMsg = text;
      lbl.textContent = text.substring(0, 56).toUpperCase();
    }
  });

  const result = await window.gp.installPips();

  if (result.ok) {
    lbl.textContent = 'Packages installed successfully';
    this.classList.remove('working');
    this.style.display = 'none';
    setTimeout(() => runDepCheck(), 400);
  } else {
    lbl.textContent = 'Install failed \u2014 run pip manually';
    this.disabled    = false;
    this.classList.remove('working');
  }
});

// ── Game selection (Step 2) ───────────────────────────────────────────────────

function selectGame(row) {
  document.querySelectorAll('.game-row').forEach(r => r.classList.remove('sel'));
  row.classList.add('sel');
  selectedGame = row.dataset.game;
  window.gp.setProfile(selectedGame);
}

document.querySelectorAll('.game-row:not(.off)').forEach(row => {
  row.addEventListener('click', () => selectGame(row));
});

// ── Launch (Step 3) ───────────────────────────────────────────────────────────

async function launch() {
  btnNext.disabled    = true;
  btnNext.textContent = 'LOADING\u2026';
  await window.gp.complete();
}

// ── Init ──────────────────────────────────────────────────────────────────────

goTo(0);
