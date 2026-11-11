"""Prospective native capture with isolated source files, never personal chats."""
import contextlib
import importlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

PACKAGE = Path(__file__).resolve().parents[2] / 'packages' / 'ai-verse-codex-learning'
sys.path.insert(0, str(PACKAGE))
capture = importlib.import_module('prospective_capture')

class Host:
    def __init__(self, root, harness):
        self.root = root
        self.harness = harness
        self.config = {'chat_history': 'prospective'}
        self.saved = {'scope': 'operator'}
        self.allowed = True
    def state(self, session): return json.loads(json.dumps(self.saved))
    def save(self, state): self.saved = json.loads(json.dumps(state))
    def scope(self, cwd, prompt): return 'operator'
    def owner(self, operation, payload):
        return {'scope': 'operator', 'decision': 'allow' if self.allowed else 'deny'}
    @contextlib.contextmanager
    def lock(self, session): yield

class ProspectiveCaptureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        (self.root / "AI-VERSE.yaml").write_text("architecture: unified-workspace\n")
        self.source = self.root / 'session.jsonl'
        self.host = Host(self.root, 'claude')
        self.event = {'session_id': 'session', 'cwd': str(self.root),
                      'transcript_path': str(self.source), 'hook_event_name': 'SessionStart',
                      'source': 'startup'}
        self.source.write_bytes(b'')
    def append(self, role, text, **more):
        row = {'type': role, 'version': '2.1.316', 'sessionId': 'session', 'message': {'role': role, 'content': text}, **more}
        with self.source.open('ab') as f: f.write(json.dumps(row, ensure_ascii=False).encode() + b'\n')
    def files(self): return list((self.root / 'archives').rglob('*.jsonl'))
    def messages(self):
        return [json.loads(x) for x in self.files()[0].read_text().splitlines()][1:]
    def test_new_boundary_exact_capture_and_replay(self):
        self.assertEqual(capture.capture(self.host, self.event)['status'], 'recording')
        text = '  café 中文\n\t  '
        self.append('user', text, timestamp='2026-11-11T10:00:00Z')
        self.append('assistant', 'reply')
        self.event['hook_event_name'] = 'Stop'
        self.assertEqual(capture.capture(self.host, self.event)['saved'], 2)
        self.assertEqual(capture.capture(self.host, self.event)['saved'], 0)
        self.assertEqual([m['text'] for m in self.messages()], [text, 'reply'])
        self.assertEqual(self.messages()[0]['timestamp'], '2026-11-11T10:00:00Z')
    def test_late_start_and_resumed_history_never_endorsed(self):
        self.append('user', 'old private message')
        self.assertEqual(capture.capture(self.host, self.event)['status'], 'blocked')
        self.assertEqual(self.files(), [])
        self.source.write_bytes(b'')
        self.event['source'] = 'resume'
        self.assertEqual(capture.capture(self.host, self.event)['status'], 'blocked')
    def test_scope_revocation_and_source_edit_preserve_archive(self):
        capture.capture(self.host, self.event)
        self.append('user', 'original')
        self.event['hook_event_name'] = 'Stop'
        capture.capture(self.host, self.event)
        self.host.allowed = False
        self.assertEqual(capture.capture(self.host, self.event)['status'], 'blocked')
        self.host.allowed = True
        self.source.write_bytes(self.source.read_bytes().replace(b'original', b'modified'))
        self.assertEqual(capture.capture(self.host, self.event)['status'], 'blocked')
        self.assertEqual(self.messages()[0]['text'], 'original')
    def test_partial_tail_is_retried_without_duplicates(self):
        capture.capture(self.host, self.event)
        self.append('user', 'complete')
        data = json.dumps({'type': 'assistant', 'version': '2.1.316', 'sessionId': 'session', 'message': {'role': 'assistant', 'content': 'later'}}).encode()
        with self.source.open('ab') as f: f.write(data[:15])
        self.event['hook_event_name'] = 'Stop'
        self.assertEqual(capture.capture(self.host, self.event)['status'], 'pending')
        with self.source.open('ab') as f: f.write(data[15:] + b'\n')
        self.assertEqual(capture.capture(self.host, self.event)['saved'], 1)
        self.assertEqual(len(self.messages()), 2)
    def test_startup_before_file_then_exact_first_prompt(self):
        self.source.unlink()
        self.assertEqual(capture.capture(self.host, self.event)["status"], "recording")
        self.append("user", "first prompt")
        self.event.update(hook_event_name="UserPromptSubmit", prompt="first prompt")
        self.assertEqual(capture.capture(self.host, self.event)["saved"], 1)
        self.append("assistant", "reply")
        self.event["hook_event_name"] = "Stop"
        self.assertEqual(capture.capture(self.host, self.event)["saved"], 1)
        self.assertEqual(len(self.messages()), 2)

    def test_private_session_never_backfilled(self):
        capture.capture(self.host, self.event)
        self.append('user', 'public first')
        self.event['hook_event_name'] = 'Stop'
        capture.capture(self.host, self.event)
        self.event['capture_opt_out'] = True
        self.append('user', 'private interval')
        self.assertEqual(capture.capture(self.host, self.event)['status'], 'blocked')
        del self.event['capture_opt_out']
        self.append('assistant', 'still private')
        self.assertEqual(capture.capture(self.host, self.event)['status'], 'blocked')
        self.assertEqual([m['text'] for m in self.messages()], ['public first'])

    def test_reenabled_capture_requires_new_chat(self):
        self.host.config['chat_history_epoch'] = 'first'
        capture.capture(self.host, self.event)
        self.append('user', 'public first')
        self.event['hook_event_name'] = 'Stop'
        capture.capture(self.host, self.event)
        self.host.config['chat_history'] = 'off'
        self.append('user', 'disabled interval')
        self.assertEqual(capture.capture(self.host, self.event)['status'], 'disabled')
        self.host.config.update(chat_history='prospective', chat_history_epoch='second')
        self.assertEqual(capture.capture(self.host, self.event)['status'], 'blocked')
        self.assertEqual([m['text'] for m in self.messages()], ['public first'])

    def test_real_config_mode_and_helper_toggles_rotate_consent(self):
        import io
        import bridge
        extension = self.root / '.aiverse/extensions/ai-verse-codex-learning'
        extension.mkdir(parents=True)
        config = extension / 'config.json'
        config.write_text(json.dumps({'enabled': True, 'review_mode': 'off', 'chat_history': 'prospective'}))
        previous = 'initial'
        for args in (['--chat-history', 'off'], ['--chat-history', 'prospective'],
                     ['--enabled', 'false'], ['--enabled', 'true']):
            with mock.patch.object(sys, 'argv', ['bridge', '--root', str(self.root), 'set', *args]), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(bridge.main(), 0)
            # Constructor must accept the saved configuration on the next hook.
            current = bridge.Bridge(self.root).config['chat_history_epoch']
            self.assertNotEqual(current, previous)
            previous = current

    def test_bridge_dispatch_survives_learning_early_return(self):
        from bridge import Bridge
        fake = mock.Mock()
        fake.config = {"chat_history": "prospective"}
        fake.root = self.root
        fake.registered.return_value = True
        fake._learning_hook.return_value = {"original": "result"}
        collector = mock.Mock()
        collector.capture.return_value = {"status": "saved", "saved": 1}
        with mock.patch("bridge.safe", return_value=PACKAGE / "prospective_capture.py"), mock.patch("bridge.load_module", return_value=collector):
            self.assertEqual(Bridge.hook(fake, self.event), {"original": "result"})
        collector.capture.assert_called_once_with(fake, self.event)

    def test_native_codex_excludes_harness_context_and_analysis(self):
        self.host.harness = 'codex'
        self.source = self.root / 'rollout-session.jsonl'
        self.event['transcript_path'] = str(self.source)
        self.source.write_text(json.dumps({'type': 'session_meta', 'payload': {'id': 'session', 'cli_version': '0.167.0', 'cwd': str(self.root)}}) + '\n')
        self.assertEqual(capture.capture(self.host, self.event)['status'], 'recording')
        rows = [
          {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'injected context'}]}},
          {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'real user'}], 'internal_chat_message_metadata_passthrough': {'content_item_kinds': ['user.text'], 'content_item_metadata': [{'provenance': {'type': 'user'}}]}}},
          {'type': 'response_item', 'payload': {'type': 'message', 'role': 'assistant', 'channel': 'analysis', 'content': [{'type': 'output_text', 'text': 'private reasoning'}]}},
          {'type': 'response_item', 'payload': {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'real reply'}]}},
        ]
        with self.source.open('ab') as f:
            for row in rows: f.write(json.dumps(row).encode() + b'\n')
        self.event['hook_event_name'] = 'Stop'
        self.assertEqual(capture.capture(self.host, self.event)['saved'], 2)
        self.assertEqual([m['text'] for m in self.messages()], ['real user', 'real reply'])

if __name__ == '__main__': unittest.main()
