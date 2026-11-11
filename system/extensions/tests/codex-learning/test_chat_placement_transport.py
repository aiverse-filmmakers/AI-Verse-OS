"""Placement transport requires a live original user confirmation."""
import json
from pathlib import Path
import sys
import shutil
import time
import unittest
from unittest import mock
import test_chat_archive as fixture

PACKAGE = Path(__file__).resolve().parents[2] / 'packages/ai-verse-codex-learning'
sys.path.insert(0, str(PACKAGE))
import bridge


class PlacementTransportTests(unittest.TestCase):
    def setUp(self):
        fixture.ArchiveFixtureTests.setUp(self)
        self.root = self.root.resolve()
        (self.root / 'AI-VERSE.yaml').write_text('architecture: unified-workspace\n')
        fixture.ArchiveFixtureTests.workspace(self, 'film')
        self.chat = fixture.ArchiveFixtureTests.archive(self)
        self.chat.append(fixture.event())
        installed = self.root / '.aiverse/extensions/ai-verse-codex-learning'
        shutil.copytree(PACKAGE, installed, ignore=shutil.ignore_patterns('__pycache__'))
        self.bridge = bridge.load_module(installed / 'bridge.py', '_test_installed_placement_transport')
        self.b = self.bridge.Bridge(self.root)
        self.b.registered = mock.Mock(return_value=True)
        self.b.owner = mock.Mock(side_effect=lambda operation, payload: {'scope': payload['scope'], 'decision': 'allow'})
        self.session = 'transport-session'
        self.turn('first', 'Move this conversation to the film project.', ['operator', 'workspace:film'])

    def turn(self, identity, quote, allowed):
        state = self.b.state(self.session)
        state.update(scope='operator', turn={'id': identity, 'token': 'token', 'state': 'active',
            'created': time.time(), 'permission_mode': 'default', 'allowed': allowed,
            'sources': {'user': {'kind': 'user', 'scopes': allowed, 'secret_like': False,
                                 **bridge.proof(quote, 4096)}}})
        self.b.save(state)

    def test_move_requires_real_current_user_quote_and_approved_preview(self):
        plan = self.b.history('plan', {'archive_id': self.chat.archive_id, 'from': 'operator',
                                      'to': 'workspace:film'}, self.session, 'first', 'token')
        quote = 'I confirm this move ' + plan['fingerprint']
        self.turn('second', 'I have not confirmed anything.', ['operator'])
        payload = {'fingerprint': plan['fingerprint'], 'confirm': True, 'quote': quote}
        with self.assertRaises(self.bridge.Refused):
            self.b.history('move', payload, self.session, 'second', 'token')
        self.assertEqual(self.chat.read().messages[0]['text'], fixture.event().text)
        self.turn('third', quote, ['operator'])
        result = self.b.history('move', payload, self.session, 'third', 'token')
        self.assertEqual(result['status'], 'moved')
        self.assertNotIn('chat_placement_plan', self.b.state(self.session))

    def test_preview_refuses_destination_outside_original_user_turn(self):
        self.turn('limited', 'Review this chat.', ['operator'])
        with self.assertRaises(self.bridge.Refused):
            self.b.history('plan', {'archive_id': self.chat.archive_id, 'from': 'operator',
                'to': 'workspace:film'}, self.session, 'limited', 'token')

if __name__ == '__main__': unittest.main()
