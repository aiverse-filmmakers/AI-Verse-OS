"""Run a real Codex binary against a loopback-only synthetic model. No credentials."""
import http.server, json, os, pathlib, subprocess, tempfile, threading, sys
PACKAGE = pathlib.Path(__file__).resolve().parents[2] / 'packages' / 'ai-verse-codex-learning'
sys.path.insert(0, str(PACKAGE))
from prospective_capture import _text

from native_mock_openai import Mock

root = pathlib.Path(tempfile.mkdtemp(prefix='aiverse-native-codex-proof-')).resolve()
(root / 'workspace').mkdir()
(root / 'home').mkdir()
(root / 'codex').mkdir()
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Mock)
threading.Thread(target=server.serve_forever, daemon=True).start()
env = {k: v for (k, v) in os.environ.items() if k in ('PATH', 'TMPDIR', 'SYSTEMROOT')}
env.update(HOME=str(root / 'home'), CODEX_HOME=str(root / 'codex'))
args = [sys.argv[1], 'exec', '--skip-git-repo-check', '--json', '-c', 'model="gpt-5.2"', '-c', 'model_provider="proof"', '-c', 'model_providers.proof.name="Offline fixture"', '-c', f'model_providers.proof.base_url="http://127.0.0.1:{server.server_port}/v1"', '-c', 'model_providers.proof.wire_api="responses"', '-c', 'model_providers.proof.requires_openai_auth=false', 'portable-native-proof-prompt']
r = subprocess.run(args, cwd=root / 'workspace', env=env, capture_output=True, text=True, timeout=90)
server.shutdown()
if r.returncode != 0:
    raise SystemExit('native Codex synthetic turn failed')
paths = list((root / 'codex').rglob('*.jsonl'))
if len(paths) != 1:
    raise SystemExit('expected exactly one isolated native transcript')
blocks = []
for line in paths[0].read_bytes().splitlines():
    blocks.extend(_text(json.loads(line), 'codex'))
visible = [(role, text) for (_, role, text) in blocks]
if visible != [('user', 'portable-native-proof-prompt'), ('assistant', 'portable-native-proof-reply')]:
    raise SystemExit('native transcript visible-text contract mismatch')
outputs = [json.loads(line) for line in r.stdout.splitlines() if line.strip()]
assert any((row.get('item', {}).get('text') == 'portable-native-proof-reply' for row in outputs))
print('PASS: real native Codex visible prompt and displayed reply match the portable parser')
import shutil
shutil.rmtree(root)
