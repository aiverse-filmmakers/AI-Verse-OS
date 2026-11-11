"""Native request timing and process-death proof; never seed archive messages."""
from pathlib import Path
import json
import os
import signal
import subprocess
import sys
import threading


def durable_prompt(root, prompt):
    from chat_archive import pending_prompts
    listing = pending_prompts(root, 'operator', lambda scope: scope == 'operator')
    for item in listing['items']:
        page = pending_prompts(root, 'operator', lambda scope: scope == 'operator', journal_id=item['journal_id'])
        if any(row['text'] == prompt for row in page['messages']):
            return True
    for path in (root / 'archives/private-chat-history/v1').rglob('*.jsonl'):
        for line in path.read_text().splitlines()[1:]:
            row = json.loads(line)
            if row.get('role') == 'user' and row.get('text') == prompt:
                return True
    return False


def kill_before_reply(command, root, env, server, prompt):
    arrived, release = threading.Event(), threading.Event()
    def hold_response():
        server.crash_prompt_durable = durable_prompt(root, prompt)
        arrived.set()
        release.wait(90)
    server.before_model = hold_response
    process = subprocess.Popen(command, cwd=root, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        assert arrived.wait(60), 'native resumed process must reach a real model request'
        assert server.crash_prompt_durable, 'submitted prompt must be durable before reply or process death'
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        process.communicate(timeout=15)
        release.set()
        server.before_model = None
    assert durable_prompt(root, prompt), 'killing the native app must preserve its exact submitted words'


def verify_copied_pending(copied, env, prompt):
    # Only the copied OS package is imported, with source/provider history gone.
    reader = r'''
from pathlib import Path
import sys, json
root = Path.cwd()
sys.path.insert(0, str(root / '.aiverse/extensions/ai-verse-codex-learning'))
from chat_archive import pending_prompts
prompt = sys.argv[1]
found = False
listing = pending_prompts(root, 'operator', lambda scope: scope == 'operator')
for item in listing['items']:
    page = pending_prompts(root, 'operator', lambda scope: scope == 'operator', journal_id=item['journal_id'])
    found |= any(row['text'] == prompt for row in page['messages'])
for path in (root / 'archives/private-chat-history/v1/operator').glob('*.jsonl'):
    for line in path.read_text().splitlines()[1:]:
        row = json.loads(line)
        found |= row.get('role') == 'user' and row.get('text') == prompt
assert found, 'copied OS must recover the original prompt after native process death and provider history removal'
'''
    subprocess.run([sys.executable, '-c', reader, prompt], cwd=copied, env=env, check=True, timeout=30)
