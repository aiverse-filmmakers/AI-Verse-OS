// Starts the learning worker on any Node. Plain syntax only (no optional chaining), so an old Node reaches this file, says
// why it cannot continue in runtime/learn/status.json, and exits. The worker itself needs Node 22.13+ for node:sqlite.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const at = args.indexOf('--root');
const root = at >= 0 ? path.resolve(args[at + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function status(code) {
  try {
    const dir = path.join(root, 'runtime', 'learn');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ code: code, node: process.versions.node, at: new Date().toISOString() }));
  } catch (error) { /* nothing more can be recorded */ }
}

// Learning off, unconfigured or unreadable: this program does nothing at all, not even leave a diagnostic file.
function enabled() {
  try {
    const mode = JSON.parse(fs.readFileSync(path.join(root, '.aiverse', 'learn', 'config.json'), 'utf8')).mode;
    return mode === 'propose' || mode === 'auto';
  } catch (error) { return false; }
}
if (!enabled()) process.exit(0);

const parts = process.versions.node.split('.').map(Number);
if (parts[0] < 22 || (parts[0] === 22 && parts[1] < 13)) {
  status('node_too_old');
  process.exit(0);
}
process.removeAllListeners('warning'); // node:sqlite's experimental notice
import('./learn-worker.mjs').then((worker) => worker.main(args)).catch(() => { status('worker_failed'); process.exit(0); });
