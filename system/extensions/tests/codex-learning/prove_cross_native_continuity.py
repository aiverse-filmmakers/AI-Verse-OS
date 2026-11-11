"""Claude -> copied folder -> Codex -> copied folder -> fresh Claude.

Real native lifecycle/context transport, synthetic loopback providers only.
The next provider must actually receive the earlier exact archived reply in
its Memory context, after the old provider's entire local home is removed.
"""
from pathlib import Path
import hashlib
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid

from prove_native_capture_roundtrip import prepare, PACKAGE
from prove_native_codex_roundtrip import approve_fixture
from lifecycle import definition, claude_definition
from native_mock_anthropic import Mock as ClaudeMock
from native_mock_openai import Mock as CodexMock


def main():
    with tempfile.TemporaryDirectory(prefix='aiverse-cross-native-') as tmp:
        base = Path(tmp).resolve()
        root = base / 'os-first'
        root.mkdir()
        prepare(root, Path(sys.argv[3]).resolve())
        build = hashlib.sha256((PACKAGE / 'bridge.py').read_bytes()).hexdigest()
        common_env = {k:v for k,v in os.environ.items() if k in ('PATH','TMPDIR','SYSTEMROOT')}
        previous_home = None
        prior_reply = None
        for phase, harness in enumerate(('claude','codex','claude')):
            if phase:
                destination = base / ('os-copy-' + str(phase))
                shutil.copytree(root, destination)
                shutil.rmtree(root)
                shutil.rmtree(previous_home)
                root = destination
            home = base / ('native-home-' + str(phase))
            home.mkdir()
            env = {**common_env, 'HOME': str(home)}
            mock = ClaudeMock if harness == 'claude' else CodexMock
            server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), mock)
            server.reply = ('Claude' if harness == 'claude' else 'Codex') + ' exact cross-native-reference response ' + str(phase)
            server.expected_context = prior_reply
            threading.Thread(target=server.serve_forever, daemon=True).start()
            prompt = 'Continue our cross-native-reference conversation using the saved local history.'
            if harness == 'claude':
                env.update(CLAUDE_CONFIG_DIR=str(home/'claude'), ANTHROPIC_API_KEY='offline-synthetic-only',
                    ANTHROPIC_BASE_URL=f'http://127.0.0.1:{server.server_port}',
                    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', DISABLE_AUTOUPDATER='1')
                settings = base / ('claude-settings-' + str(phase) + '.json')
                settings.write_text(json.dumps(claude_definition(root, sys.executable, build=build)))
                command = [sys.argv[1], '-p', '--settings', str(settings), '--model', 'claude-sonnet-4-5',
                           '--session-id', str(uuid.uuid4()), prompt]
            else:
                env['CODEX_HOME'] = str(home/'codex')
                Path(env['CODEX_HOME']).mkdir()
                folder = root / '.codex'
                folder.mkdir(exist_ok=True)
                (folder/'hooks.json').write_text(json.dumps(definition(root, sys.executable, build=build)))
                approve_fixture(sys.argv[2], root, env)
                command = [sys.argv[2], 'exec', '--skip-git-repo-check', '--json',
                    '-c','features.codex_hooks=true','-c','model="gpt-5.2"','-c','model_provider="proof"',
                    '-c','model_providers.proof.name="Offline fixture"',
                    '-c',f'model_providers.proof.base_url="http://127.0.0.1:{server.server_port}/v1"',
                    '-c','model_providers.proof.wire_api="responses"',
                    '-c','model_providers.proof.requires_openai_auth=false',prompt]
            try:
                result = subprocess.run(command, cwd=root, env=env, capture_output=True, text=True, timeout=150)
                if result.returncode or server.reply not in result.stdout:
                    raise AssertionError('native cross-interface fixture conversation failed')
                if prior_reply and not getattr(server, 'saw_expected_context', False):
                    raise AssertionError('next native model did not receive the exact previous archived reply')
            finally:
                server.shutdown()
            prior_reply = server.reply
            previous_home = home
        files = list((root/'archives/private-chat-history/v1').rglob('*.jsonl'))
        assert len(files) == 3, 'each native conversation must have its own archive'
        print('PASS: both native interfaces received exact earlier chat context from copied OS folders after original provider homes were removed')

if __name__ == '__main__': main()
