function parseArgs(argv) {
  const out = { phase: null, all: false, retryFromDb: false };
  for (const a of argv) {
    if (a.startsWith('--phase=')) out.phase = Number(a.slice('--phase='.length));
    if (a === '--all') out.all = true;
    if (a === '--retry-from-db') out.retryFromDb = true;
  }
  return out;
}

// CC_DIR env var documents the directory holding the canonical CC CSVs. Default to
// the operator's known download location; override via env for CI / other machines.
const CC_DIR = process.env.CC_DIR || 'C:\\Users\\dalla\\Downloads';

module.exports = { parseArgs, CC_DIR };
