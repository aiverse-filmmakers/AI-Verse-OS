"""OS relocation authority, interrupted transactions and exact immutable text."""
import json
import unittest
from unittest import mock
import test_chat_archive as fixture
a, event = fixture.a, fixture.event


class ChatPlacementTests(unittest.TestCase):
    def setUp(self):
        fixture.ArchiveFixtureTests.setUp(self)
        self.root = self.root.resolve()
    workspace = fixture.ArchiveFixtureTests.workspace
    archive = fixture.ArchiveFixtureTests.archive
    path = fixture.ArchiveFixtureTests.path

    def prepare(self):
        self.workspace('film')
        self.workspace('music')
        chat = self.archive()
        chat.append(event())
        check = lambda scope: self.scope_grants.get(scope, True)
        plan = a.plan_move(self.root, chat.archive_id, 'operator', 'workspace:film', check)
        return chat, check, plan

    def move(self, chat, check, plan):
        return a.move_archive(self.root, chat.archive_id, plan['from'], plan['to'],
            fingerprint=plan['fingerprint'], confirmed=True, authorization_check=check)

    def test_move_preserves_messages_closes_original_capture_and_can_move_again(self):
        chat, check, plan = self.prepare()
        original = chat.read().messages[0]
        self.move(chat, check, plan)
        self.assertFalse(self.path(chat).exists())
        with self.assertRaises(a.ArchiveBlocked):
            chat.read()
        moved = self.archive(scope='workspace:film')
        row = moved.read().messages[0]
        for key in ('message_id', 'source_event_id', 'text', 'source_record_sha256', 'sequence'):
            self.assertEqual(row[key], original[key])
        with self.assertRaises(a.ArchiveBlocked):
            moved.append(event('later', sequence=2, offset=100, end=200))
        second = a.plan_move(self.root, chat.archive_id, 'workspace:film', 'workspace:music', check)
        self.move(chat, check, second)
        self.assertEqual(self.archive(scope='workspace:music').read().messages[0]['text'], original['text'])
        receipt = a.placement_receipt(self.root, chat.archive_id, 'operator')
        self.assertEqual(receipt['previous_scopes'], ['operator', 'workspace:film'])

    def test_same_local_id_in_another_project_keeps_its_own_identity(self):
        chat, check, plan = self.prepare()
        unrelated = self.archive(scope='workspace:music')
        unrelated.append(event(text='unrelated music private chat'))
        self.move(chat, check, plan)
        self.assertEqual(unrelated.read().messages[0]['text'], 'unrelated music private chat')
        self.assertNotEqual(a.placement_key('operator', chat.archive_id),
                            a.placement_key('workspace:music', chat.archive_id))

    def test_tidy_preview_pages_visit_later_chats_without_other_project_content(self):
        first, check, _ = self.prepare()
        second = self.archive(archive_id='portable-chat-b')
        second.append(event(text='later Personal chat'))
        private = self.archive(scope='workspace:music', archive_id='portable-chat-c')
        private.append(event(text='unrelated hidden music chat'))
        page = a.list_archives(self.root, 'operator', check, limit=1)
        self.assertTrue(page['truncated'])
        self.assertEqual(page['chats'][0]['archive_id'], first.archive_id)
        continued = a.list_archives(self.root, 'operator', check, limit=1, after=page['next_archive'])
        self.assertFalse(continued['truncated'])
        self.assertEqual(continued['chats'][0]['excerpt'], 'later Personal chat')
        self.assertNotIn('unrelated hidden music chat', str(page) + str(continued))

    def test_direct_transcript_view_is_exact_paged_and_scoped(self):
        chat, check, _ = self.prepare()
        chat.append(event('second', sequence=2, offset=100, end=200, text='second exact reply'))
        first = a.read_transcript(self.root, 'operator', chat.archive_id, check, limit=1)
        self.assertEqual(first['messages'][0]['text'], event().text)
        self.assertEqual(first['next_sequence'], 1)
        second = a.read_transcript(self.root, 'operator', chat.archive_id, check, after=first['next_sequence'])
        self.assertEqual(second['transcript'], 'Assistant\n\nsecond exact reply')
        self.assertIsNone(second['next_sequence'])
        self.scope_grants['operator'] = False
        with self.assertRaises(a.ArchiveBlocked):
            a.read_transcript(self.root, 'operator', chat.archive_id, check)

    def test_stale_preview_and_revoked_destination_never_move(self):
        chat, check, plan = self.prepare()
        chat.append(event('later', sequence=2, offset=100, end=200))
        with self.assertRaises(a.ArchiveBlocked):
            self.move(chat, check, plan)
        self.scope_grants['workspace:film'] = False
        with self.assertRaises(a.ArchiveBlocked):
            a.plan_move(self.root, chat.archive_id, 'operator', 'workspace:film', check)
        self.assertEqual(len(chat.read().messages), 2)

    def test_interrupted_move_denies_both_homes_and_requires_exact_recovery(self):
        chat, check, plan = self.prepare()
        with mock.patch.object(a, '_finish_move', side_effect=OSError('synthetic interruption')):
            with self.assertRaises(OSError):
                self.move(chat, check, plan)
        for scope in ('operator', 'workspace:film'):
            with self.assertRaises(a.ArchiveBlocked):
                self.archive(scope=scope).read()
        with self.assertRaises(a.ArchiveBlocked):
            a.recover_move(self.root, chat.archive_id, source_scope=plan['from'], fingerprint='0'*64,
                          confirmed=True, authorization_check=check)
        a.recover_move(self.root, chat.archive_id, source_scope=plan['from'], fingerprint=plan['fingerprint'],
                       confirmed=True, authorization_check=check)
        self.assertEqual(self.archive(scope='workspace:film').read().messages[0]['text'], event().text)

    def test_interruption_after_target_written_keeps_one_authoritative_copy(self):
        chat, check, plan = self.prepare()
        real = a._atomic_private
        calls = []
        def stop_before_commit(path, wire):
            calls.append(path.suffix)
            if path.suffix == '.json' and path.parent.name == 'placements' and b'\"status\":\"committed\"' in wire:
                raise OSError('synthetic interruption after source removal')
            return real(path, wire)
        with mock.patch.object(a, '_atomic_private', side_effect=stop_before_commit):
            with self.assertRaises(OSError):
                self.move(chat, check, plan)
        self.assertFalse(self.path(chat).exists())
        self.assertEqual(a.placement_receipt(self.root, chat.archive_id, 'operator')['status'], 'moving')
        a.recover_move(self.root, chat.archive_id, source_scope=plan['from'], fingerprint=plan['fingerprint'],
                       confirmed=True, authorization_check=check)
        self.assertEqual(a.placement_receipt(self.root, chat.archive_id, 'operator')['status'], 'committed')

    def test_unconfirmed_move_never_changes_archive(self):
        chat, check, plan = self.prepare()
        with self.assertRaises(a.ArchiveBlocked):
            a.move_archive(self.root, chat.archive_id, 'operator', 'workspace:film',
                fingerprint=plan['fingerprint'], confirmed=False, authorization_check=check)
        self.assertEqual(chat.read().messages[0]['text'], event().text)

if __name__ == '__main__': unittest.main()
