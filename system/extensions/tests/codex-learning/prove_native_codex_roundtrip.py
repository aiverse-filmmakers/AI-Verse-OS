"""Fresh Codex-native hook approval, capture and exact portable Memory read.

Only synthetic fixture hooks are approved through the same config RPC used by
Codex's UI. Existing user trust/configuration and accounts are never accessed.
"""
from pathlib import Path
import hashlib
import http.server
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading

from native_mock_openai import Mock
from prove_native_capture_roundtrip import prepare, PACKAGE
from lifecycle import definition


def approve_fixture(binary, root, env):
    process = subprocess.Popen([binary, '-c', 'features.codex_hooks=true', 'app-server'],
        cwd=root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, text=True, bufsize=1)
    messages = queue.Queue()
    def pump():
        for line in process.stdout:
            try:
                messages.put(json.loads(line))
            except ValueError:
                pass
        messages.put(None)
    threading.Thread(target=pump, daemon=True).start()
    counter = 0
    def request(method, params):
        nonlocal counter
        counter += 1
        process.stdin.write(json.dumps({'id': counter, 'method': method, 'params': params}) + '\n')
        process.stdin.flush()
        while True:
            response = messages.get(timeout=30)
            if response is None:
                raise RuntimeError('native fixture approval server exited')
            if response.get('id') == counter:
                if 'error' in response:
                    raise RuntimeError('native fixture approval RPC failed: ' + json.dumps(response['error']))
                return response['result']
    try:
        request('initialize', {'clientInfo': {'name': 'aiverse_capture_fixture', 'version': '1'},
                              'capabilities': {'experimentalApi': True}})
        process.stdin.write('{"method":"initialized"}\n')
        process.stdin.flush()
        # These approvals apply solely to a new fixture folder and its known
        # package commands. No bypass flag or prewritten trust store is used.
        request('config/batchWrite', {'edits': [{'keyPath': 'projects.' + json.dumps(str(root)) + '.trust_level',
                'value': 'trusted', 'mergeStrategy': 'upsert'}], 'reloadUserConfig': True})
        listing = request('hooks/list', {'cwds': [str(root)]})
        hooks = listing['data'][0]['hooks']
        if len(hooks) != 6 or any(h.get('trustStatus') != 'untrusted' for h in hooks):
            raise RuntimeError('fresh native fixture must require hook approval')
        values = {h['key']: {'trusted_hash': h['currentHash']} for h in hooks}
        if not values:
            raise RuntimeError('native fixture hook inventory empty')
        request('config/batchWrite', {'edits': [{'keyPath': 'hooks.state', 'value': values,
                    'mergeStrategy': 'upsert'}], 'reloadUserConfig': True})
        approved = request('hooks/list', {'cwds': [str(root)]})
        if any(h.get('trustStatus') not in {'trusted', 'approved'} for h in approved['data'][0]['hooks']):
            raise RuntimeError('native fixture hook trust not confirmed')
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=5)


def main():
    with tempfile.TemporaryDirectory(prefix='aiverse-codex-hook-proof-') as temporary:
        base = Path(temporary).resolve()
        root = base / 'os'
        root.mkdir()
        prepare(root, Path(sys.argv[2]).resolve())
        settings = definition(root, sys.executable,
            build=hashlib.sha256((PACKAGE / 'bridge.py').read_bytes()).hexdigest())
        (root / '.codex').mkdir()
        (root / '.codex/hooks.json').write_text(json.dumps(settings))
        home = base / 'home'
        codex_home = base / 'codex'
        home.mkdir()
        codex_home.mkdir()
        env = {k: v for k, v in os.environ.items() if k in ('PATH','TMPDIR','SYSTEMROOT')}
        env.update(HOME=str(home), CODEX_HOME=str(codex_home))
        approve_fixture(sys.argv[1], root, env)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Mock)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        command = [sys.argv[1], 'exec', '--skip-git-repo-check', '--json',
            '-c', 'features.codex_hooks=true', '-c', 'model="gpt-5.2"',
            '-c', 'model_provider="proof"', '-c', 'model_providers.proof.name="Offline fixture"',
            '-c', f'model_providers.proof.base_url="http://127.0.0.1:{server.server_port}/v1"',
            '-c', 'model_providers.proof.wire_api="responses"',
            '-c', 'model_providers.proof.requires_openai_auth=false', 'portable-native-proof-prompt']
        try:
            result = subprocess.run(command, cwd=root, env=env, capture_output=True, text=True, timeout=120)
            if result.returncode:
                raise SystemExit('first native fixture turn failed')
            resumed = [command[0], 'exec', 'resume', '--last', *command[2:]]
            result = subprocess.run(resumed, cwd=root, env=env, capture_output=True, text=True, timeout=120)
        finally:
            server.shutdown()
        if result.returncode:
            raise SystemExit('native fixture turn failed')
        files = list((root / 'archives/private-chat-history/v1').rglob('*.jsonl'))
        if len(files) != 1:
            for file in (root / 'runtime').rglob('events.jsonl'):
                print(file.read_text()[-5000:])
            raise SystemExit('native Codex hook capture did not produce one archive')
        messages = [json.loads(line) for line in files[0].read_text().splitlines()][1:]
        assert [m['text'] for m in messages] == ['portable-native-proof-prompt','portable-native-proof-reply'] * 2
        copied = base / 'copied-os'
        shutil.copytree(root, copied)
        shutil.rmtree(root)
        shutil.rmtree(codex_home)
        reader = """
from pathlib import Path
import sys
sys.path.insert(0, str(Path.cwd() / 'scripts/ai-verse-memory'))
import memory
root = Path.cwd()
detail = memory.progressive_recall('portable-native-proof-reply', depth='detail',
    root=root, mode=memory.MODE_NATIVE, scope='operator', max_bytes=10000)
item = next(row for row in detail['items']
    if row['record_type'] == 'portable_chat_message' and row['role'] == 'assistant')
source = memory.progressive_recall('portable-native-proof-reply', depth='source',
    root=root, mode=memory.MODE_NATIVE, scope='operator', evidence_ref=item, max_bytes=10000)
assert source['exact_evidence'] and source['source']['content'] == 'portable-native-proof-reply'
"""
        subprocess.run([sys.executable, '-c', reader], cwd=copied, env=env, check=True, timeout=30)
        print('PASS: native Codex approved fixture hooks saved the exact chat and copied-folder Memory retrieved its original reply')


if __name__ == '__main__':
    main()
