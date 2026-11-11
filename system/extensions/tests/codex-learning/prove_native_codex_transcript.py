"""Run a real Codex binary against a loopback-only synthetic model. No credentials."""
import http.server, json, os, pathlib, subprocess, tempfile, threading, sys
PACKAGE = pathlib.Path(__file__).resolve().parents[2] / 'packages' / 'ai-verse-codex-learning'
sys.path.insert(0, str(PACKAGE))
from prospective_capture import _text

class Mock(http.server.BaseHTTPRequestHandler):

    def log_message(self, *a):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', '0')))
        text = 'portable-native-proof-reply'
        item = {'id': 'msg_1', 'type': 'message', 'role': 'assistant', 'status': 'completed', 'content': [{'type': 'output_text', 'text': text, 'annotations': []}]}
        events = [{'type': 'response.created', 'response': {'id': 'resp_1', 'status': 'in_progress'}}, {'type': 'response.output_item.added', 'output_index': 0, 'item': {**item, 'content': [], 'status': 'in_progress'}}, {'type': 'response.content_part.added', 'item_id': 'msg_1', 'output_index': 0, 'content_index': 0, 'part': {'type': 'output_text', 'text': '', 'annotations': []}}, {'type': 'response.output_text.delta', 'item_id': 'msg_1', 'output_index': 0, 'content_index': 0, 'delta': text}, {'type': 'response.output_text.done', 'item_id': 'msg_1', 'output_index': 0, 'content_index': 0, 'text': text}, {'type': 'response.content_part.done', 'item_id': 'msg_1', 'output_index': 0, 'content_index': 0, 'part': item['content'][0]}, {'type': 'response.output_item.done', 'output_index': 0, 'item': item}, {'type': 'response.completed', 'response': {'id': 'resp_1', 'status': 'completed', 'output': [item], 'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}}]
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for e in events:
            self.wfile.write(('data: ' + json.dumps(e) + '\n\n').encode())
            self.wfile.flush()
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
