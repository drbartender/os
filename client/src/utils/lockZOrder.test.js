import '@testing-library/jest-dom';
import fs from 'fs';
import path from 'path';

// Pins the lock screen's stacking guarantee (lane fleet, 2026-08-14): five
// inline zIndex:9999 admin dialogs painted ABOVE the first draft's z 1200
// lock, leaving a money dialog visible and clickable behind "locked". The
// lock must top every z-index in the codebase except the toast container
// (transient chrome, deliberately above). A new inline dialog above the lock
// fails this test instead of silently reopening the hole.

const CLIENT_SRC = path.join(__dirname, '..');

function walk(dir, out = []) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|jsx|css)$/.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(p);
  });
  return out;
}

test('.m-lock z-index tops every non-toast z-index in client/src', () => {
  const css = fs.readFileSync(path.join(CLIENT_SRC, 'index.css'), 'utf8');
  const lockBlock = css.match(/\.m-lock \{[^}]+\}/);
  expect(lockBlock).not.toBeNull();
  const lockZ = parseInt(lockBlock[0].match(/z-index:\s*(\d+)/)[1], 10);

  const toastBlock = css.match(/\.toast-container \{[^}]+\}/);
  const toastZ = parseInt(toastBlock[0].match(/z-index:\s*(\d+)/)[1], 10);
  expect(toastZ).toBeGreaterThan(lockZ); // toasts stay above, by design

  let maxOther = 0;
  let maxWhere = '';
  walk(CLIENT_SRC).forEach((file) => {
    const text = fs.readFileSync(file, 'utf8');
    const re = /z-?[iI]ndex['"]?\s*[:=]\s*['"]?(\d+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const z = parseInt(m[1], 10);
      if (z === lockZ || z === toastZ) continue;
      if (z > maxOther) { maxOther = z; maxWhere = path.relative(CLIENT_SRC, file); }
    }
  });
  if (lockZ <= maxOther) {
    throw new Error(`highest non-lock z ${maxOther} in ${maxWhere} tops the lock (${lockZ})`);
  }
  expect(lockZ).toBeGreaterThan(maxOther);
});
