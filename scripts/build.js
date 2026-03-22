/**
 * Pre-build script — validates environment before electron-builder runs.
 * node scripts/build.js
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (e) {
    console.error(`  ✗ ${label}: ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('\nGamePartner pre-build checks\n');

check('Node >= 18', () => {
  const [maj] = process.versions.node.split('.').map(Number);
  if (maj < 18) throw new Error(`Node ${process.versions.node} — need 18+`);
});

check('Python available', () => {
  execSync('python --version', { stdio: 'ignore' });
});

check('Tesseract available', () => {
  execSync('tesseract --version', { stdio: 'ignore' });
});

check('config/default.json exists', () => {
  if (!fs.existsSync(path.join(ROOT, 'config/default.json')))
    throw new Error('missing');
});

check('Valorant profile exists', () => {
  if (!fs.existsSync(path.join(ROOT, 'src/profiles/valorant/profile.json')))
    throw new Error('missing');
});

check('node_modules present', () => {
  if (!fs.existsSync(path.join(ROOT, 'node_modules')))
    throw new Error('run npm install first');
});

check('Python requirements', () => {
  execSync('python -c "import mss, cv2, pytesseract, requests"', { stdio: 'ignore' });
});

if (process.exitCode !== 1) {
  console.log('\nAll checks passed. Running electron-builder...\n');
  execSync('npx electron-builder --win --x64', { cwd: ROOT, stdio: 'inherit' });
} else {
  console.log('\nFix the issues above before building.\n');
}
