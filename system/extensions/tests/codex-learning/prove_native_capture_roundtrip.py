"""Actual native Claude hooks -> OS archive -> copied-folder Memory source.

Run with an explicit Claude executable and Memory source checkout. Only a
loopback synthetic model is used. No account, provider or personal OS state.
"""
from pathlib import Path
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile

PACKAGE = Path(__file__).resolve().parents[2] / 'packages' / 'ai-verse-codex-learning'
OS_ROOT = PACKAGE.parents[3]
sys.path.insert(0, str(PACKAGE))
import bridge
from lifecycle import claude_definition


def prepare(root, memory_source):
    for name in ('AI-VERSE.yaml', 'AGENTS.md'):
        shutil.copy2(OS_ROOT / name, root / name)
    shutil.copytree(OS_ROOT / 'scripts', root / 'scripts', ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copytree(OS_ROOT / 'system' / 'schemas', root / 'system' / 'schemas')
    destination = root / 'scripts' / 'ai-verse-memory'
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(memory_source / 'scripts', destination, ignore=shutil.ignore_patterns('__pycache__'))
    target = root / '.aiverse' / 'extensions' / bridge.ID
    shutil.copytree(PACKAGE, target, ignore=shutil.ignore_patterns('__pycache__'))
    for name in ('operator/profile', 'operator/context', 'operator/memory', 'workspaces'):
        (root / name).mkdir(parents=True, exist_ok=True)
    (root / 'operator/profile/preferences.md').write_text('# Preferences\n')
    (root / 'operator/context/CURRENT.md').write_text('# Context\n\n## Current state\n\nSynthetic capture proof.\n')
    registry = {'schema_version': '1.0', 'extensions': {
        bridge.ID: {'id': bridge.ID, 'supported': True, 'installed': True, 'enabled': True},
        'ai-verse-memory': {'id': 'ai-verse-memory', 'supported': True, 'installed': True,
                            'enabled': True, 'engine': 'scripts/ai-verse-memory/memory.py'}}}
    (root / '.aiverse/extensions/registry.json').write_text(json.dumps(registry))
    config = {'schema_version': 1, 'enabled': True, 'review_mode': 'off',
              'reflection_enabled': False, 'chat_history': 'prospective',
              'runtime_path': str(Path(shutil.which('node')).parent), 'skills_root': str(root / 'skills')}
    (target / 'config.json').write_text(json.dumps(config))
    memory = bridge.load_module(destination / 'memory.py', '_native_capture_proof_memory')
    memory.ensure_layout(root, memory.MODE_NATIVE)
    memory.rebuild(silent=True, root=root, mode=memory.MODE_NATIVE)
    memory.public_beta_write_component_state(root, memory.MODE_NATIVE, installed=True,
        setup_completed=True, enabled=True, last_action='isolated-native-proof')
    return memory


def main():
    import http.server
    import threading
    import uuid
    with tempfile.TemporaryDirectory(prefix='aiverse-native-roundtrip-') as temporary:
        base = Path(temporary).resolve()
        root = base / 'os'
        root.mkdir()
        memory = prepare(root, Path(sys.argv[2]).resolve())
        from native_mock_anthropic import Mock
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Mock)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        home = base / 'home'
        config = base / 'claude'
        home.mkdir()
        config.mkdir()
        settings = claude_definition(root, sys.executable,
            build=hashlib.sha256((PACKAGE / 'bridge.py').read_bytes()).hexdigest())
        settings_path = base / 'settings.json'
        settings_path.write_text(json.dumps(settings))
        env = {k: v for k, v in os.environ.items() if k in ('PATH', 'TMPDIR', 'SYSTEMROOT')}
        env.update(HOME=str(home), CLAUDE_CONFIG_DIR=str(config),
            ANTHROPIC_BASE_URL=f'http://127.0.0.1:{server.server_port}',
            ANTHROPIC_API_KEY='offline-synthetic-only',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', DISABLE_AUTOUPDATER='1')
        launcher = [sys.argv[1]]
        if Path(sys.argv[1]).resolve().suffix in {'.js', '.cjs', '.mjs'}:
            launcher.insert(0, 'node')
        command = launcher + ['-p', '--settings', str(settings_path), '--model', 'claude-sonnet-4-5',
            '--session-id', str(uuid.uuid4()), 'portable-claude-proof-prompt']
        try:
            result = subprocess.run(command, cwd=root, env=env, capture_output=True, text=True, timeout=120)
            if result.returncode != 0 or 'portable-claude-proof-reply' not in result.stdout:
                raise SystemExit('first native synthetic conversation failed')
            # A separate native process resumes the same session. Identical
            # user text is a new message, never content-deduplicated history.
            resumed = ['--resume' if arg == '--session-id' else arg for arg in command]
            result = subprocess.run(resumed, cwd=root, env=env, capture_output=True, text=True, timeout=120)
        finally:
            server.shutdown()
        if result.returncode != 0 or 'portable-claude-proof-reply' not in result.stdout:
            raise SystemExit('native synthetic conversation failed')
        files = list((root / 'archives/private-chat-history/v1').rglob('*.jsonl'))
        if len(files) != 1:
            # Content-free diagnostics are sufficient to debug dispatch and permissions.
            print('Native hook archive proof failed; content-free lifecycle diagnostics follow')
            for file in (root / 'runtime').rglob('*.jsonl'):
                if file.is_file():
                    print(file.read_text()[-4000:])
            raise SystemExit('native lifecycle did not create exactly one private archive')
        messages = [json.loads(line) for line in files[0].read_text().splitlines()][1:]
        assert [row['text'] for row in messages] == ['portable-claude-proof-prompt', 'portable-claude-proof-reply'] * 2
        copied = base / 'copied-os'
        shutil.copytree(root, copied)
        shutil.rmtree(root)
        shutil.rmtree(config)
        reader = """
from pathlib import Path
import sys
sys.path.insert(0, str(Path.cwd() / 'scripts/ai-verse-memory'))
import memory
root = Path.cwd()
detail = memory.progressive_recall('portable-claude-proof-reply', depth='detail',
    root=root, mode=memory.MODE_NATIVE, scope='operator', max_bytes=10000)
item = next(row for row in detail['items']
    if row['record_type'] == 'portable_chat_message' and row['role'] == 'assistant')
source = memory.progressive_recall('portable-claude-proof-reply', depth='source',
    root=root, mode=memory.MODE_NATIVE, scope='operator', evidence_ref=item, max_bytes=10000)
assert source['exact_evidence'] and source['source']['content'] == 'portable-claude-proof-reply'
"""
        subprocess.run([sys.executable, '-c', reader], cwd=copied, env=env, check=True, timeout=30)
        print('PASS: actual native hooks archived the exact chat; Memory read its original reply from a copied folder after provider history removal')


if __name__ == '__main__':
    main()
