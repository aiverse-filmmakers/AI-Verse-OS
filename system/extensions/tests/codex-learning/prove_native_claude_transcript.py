"""Isolated real Claude Code transcript test with a loopback synthetic model."""
import http.server, json, os, pathlib, subprocess, tempfile, threading, uuid, sys
PACKAGE = pathlib.Path(__file__).resolve().parents[2] / 'packages' / 'ai-verse-codex-learning'
sys.path.insert(0, str(PACKAGE))
from prospective_capture import _text

from native_mock_anthropic import Mock

root = pathlib.Path(tempfile.mkdtemp(prefix='aiverse-native-claude-proof-')).resolve()
(root / 'workspace').mkdir()
(root / 'home').mkdir()
(root / 'config').mkdir()
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Mock)
threading.Thread(target=server.serve_forever, daemon=True).start()
env = {k: v for (k, v) in os.environ.items() if k in ('PATH', 'TMPDIR', 'SYSTEMROOT')}
env.update(HOME=str(root / 'home'), CLAUDE_CONFIG_DIR=str(root / 'config'), ANTHROPIC_BASE_URL=f'http://127.0.0.1:{server.server_port}', ANTHROPIC_API_KEY='offline-synthetic-only', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', DISABLE_AUTOUPDATER='1')
launcher = [sys.argv[1]]
if pathlib.Path(sys.argv[1]).resolve().suffix in {'.js', '.mjs', '.cjs'}:
    launcher.insert(0, 'node')
r = subprocess.run(launcher + ['-p', '--verbose', '--output-format', 'stream-json', '--model', 'claude-sonnet-4-5', '--session-id', str(uuid.uuid4()), 'portable-claude-proof-prompt'], cwd=root / 'workspace', env=env, capture_output=True, text=True, timeout=90)
server.shutdown()
if r.returncode != 0:
    raise SystemExit('native Claude synthetic turn failed')
paths = list((root / 'config').rglob('*.jsonl'))
if len(paths) != 1:
    raise SystemExit('expected one isolated native transcript')
visible = []
for line in paths[0].read_bytes().splitlines():
    visible.extend(((role, text) for (_, role, text) in _text(json.loads(line), 'claude')))
assert visible == [('user', 'portable-claude-proof-prompt'), ('assistant', 'portable-claude-proof-reply')], 'native visible-text contract mismatch'
assert any((json.loads(line).get('result') == 'portable-claude-proof-reply' for line in r.stdout.splitlines() if line.strip()))
print('PASS: real Claude Code prompt and displayed reply match the portable parser')
import shutil
shutil.rmtree(root)
