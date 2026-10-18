"""Candidate 0004: canonical Brain integration with isolated native OS fixtures."""
import concurrent.futures
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import unittest
from bridge import Bridge, Refused, atomic_json, ID
from test_bridge import fixture
from intent import IntentService


class IntentTests(unittest.TestCase):
    def setUp(self):
        self.temp, self.root = fixture()
        registry = json.loads((self.root/'.aiverse/extensions/registry.json').read_text())
        registry['extensions']['ai-verse-brain'] = {'supported':True,'installed':True,'enabled':True}
        atomic_json(self.root/'.aiverse/extensions/registry.json',registry,self.root)
        from aiverse_brain.installation import initialize
        initialize(str(self.root))
        self.service = IntentService(self.root)
        self.bridge = Bridge(self.root)
        self.seq = 0

    def tearDown(self):
        self.temp.cleanup()

    def handover(self, scope='operator'):
        plan=self.service.plan(scope)
        return self.service.handover(scope,plan['fingerprint'],True)

    def start(self, prompt, scope='operator'):
        self.seq+=1
        if scope!='operator':
            prompt='Work on '+scope+'. '+prompt
        session='intent-fixture-'+str(self.seq)
        out=self.bridge.hook({'hook_event_name':'UserPromptSubmit','session_id':session,'turn_id':'turn-'+str(self.seq),'cwd':str(self.root),'prompt':prompt})
        turn=self.bridge.state(session)['turn']
        return session,turn,out

    def capture(self, statement, **extra):
        session,turn,_=self.start(statement)
        data={'classification':'operator-goal','statement':statement,'quote':statement,'explicit_user_declaration':True, **extra}
        return self.bridge.intent('capture','operator',data,session,turn['id'],turn['token'])

    def test_heading_alias_handover_and_frozen_sources(self):
        file=self.root/'operator/context/CURRENT.md'
        original='# Context\n\n## Current priority\n\n- Build a durable research practice.\n\n## Current facts\n\n- Available on weekdays.\n'
        file.write_text(original)
        plan=self.service.plan('operator')
        self.assertEqual(len(plan['import_candidates']),1)
        self.handover()
        self.assertEqual(file.read_text(),original)
        self.assertEqual(self.service.snapshot('operator')['direction_owner'],'brain')
        self.assertEqual(self.service.snapshot('operator')['strategic_objects']['intents'][0]['payload']['statement'],'Build a durable research practice.')
        result=subprocess.run(['node',str(self.root/'scripts/current-context.mjs'),'read','--root',str(self.root),'--scope','operator'],capture_output=True,text=True,check=True)
        self.assertNotIn('Build a durable research practice',json.loads(result.stdout)['current_context'])

    def test_import_confirmation_and_fingerprint(self):
        plan=self.service.plan('operator')
        with self.assertRaises(ValueError): self.service.handover('operator',plan['fingerprint'],False)
        (self.root/'operator/context/CURRENT.md').write_text('## Current priority\n\n- Changed priority.\n')
        with self.assertRaises(ValueError): self.service.handover('operator',plan['fingerprint'],True)
        self.assertEqual(self.service.ownership.owner('operator'),'os')

    def test_capture_replay_and_new_chat_recall(self):
        self.handover()
        result=self.capture('My overall goal is to build a research practice.')
        self.assertEqual(result['state'],'saved')
        self.capture('My overall goal is to build a research practice.')
        self.assertEqual(len(self.service.snapshot('operator')['strategic_objects']['intents']),1)
        _,_,out=self.start('What should I prioritize this month to advance my overall research goal?')
        context=out['hookSpecificOutput']['additionalContext']
        self.assertIn('My overall goal is to build a research practice.',context)
        self.assertIn('ai-verse-brain',context)

    def test_correction_history_and_stale_version(self):
        self.handover()
        prior=self.capture('My overall target is 30 research interviews.')['ref']
        corrected=self.capture('My overall target is 50 research interviews.',classification='correction',supersedes=prior['id'],expected_version=int(prior['version']))
        snapshot=self.service.snapshot('operator')
        self.assertEqual(len(snapshot['strategic_objects']['intents']),1)
        self.assertEqual(corrected['supersedes'],prior['id'])
        self.assertEqual(self.service.controller.store.load('intent','operator',prior['id']).status,'SUPERSEDED')
        with self.assertRaises(ValueError):
            self.capture('My overall target is 100 research interviews.',classification='correction',supersedes=corrected['ref']['id'],expected_version=1)

    def test_inference_stays_pending_and_confirmation(self):
        self.handover()
        pending=self.capture('I might make research a longer term priority.',explicit_user_declaration=False)
        self.assertEqual(pending['state'],'awaiting-confirmation')
        self.assertEqual(self.service.snapshot('operator')['strategic_objects']['intents'],[])
        session,turn,_=self.start('Yes, that is my overall goal.')
        result=self.bridge.intent('confirm','operator',{'quote':'Yes, that is my overall goal.','intent_id':pending['ref']['id'],'expected_version':int(pending['ref']['version']),'explicit_user_declaration':True},session,turn['id'],turn['token'])
        self.assertEqual(result['status'],'ACTIVE')

    def test_workspace_only_and_unlinked_isolation(self):
        self.handover()
        self.capture('My overall goal is to build a research practice.')
        _,_,out=self.start('Plan the next workspace milestone without importing other projects.', 'workspace:beta')
        context=out['hookSpecificOutput']['additionalContext']
        self.assertNotIn('My overall goal is to build a research practice.',context)
        self.assertEqual(self.service.capture('workspace:alpha',{'classification':'workspace-goal','statement':'Finish this project.','explicit_user_declaration':True},'fixture:user','op-workspace')['state'],'owner-required')

    def test_explicit_workspace_link_without_copying_goal(self):
        self.handover()
        goal=self.capture('My overall goal is to build a research practice.')['ref']
        session,turn,_=self.start('This workspace serves my overall research goal.','workspace:alpha')
        data={'quote':'This workspace serves my overall research goal.','workspace':'alpha','intent_id':goal['id'],'explicit_relationship':True,'explicit_operator_scope':True}
        self.bridge.intent('link','operator',data,session,turn['id'],turn['token'])
        visible=self.service.relevant('workspace:alpha','Plan the next substantial research deliverable for the linked overall goal.')
        self.assertEqual(visible['linked_operator_intents'][0]['id'],goal['id'])
        self.assertNotIn('linked_operator_intents',self.service.relevant('workspace:beta','Plan the next substantial research deliverable for the linked overall goal.'))
        canonical=self.service.controller.store.load('intent','operator',goal['id'])
        self.assertEqual(canonical.payload['workspace_links'][0]['scope'],'workspace:alpha')
        self.assertNotIn('statement',canonical.payload['workspace_links'][0])
        self.assertEqual(len(self.service.controller.store.list('initiative','operator')),0)

    def test_wrong_turn_tool_claim_and_scope_rejected(self):
        self.handover()
        session,turn,_=self.start('My overall goal is research.','workspace:alpha')
        data={'quote':'My overall goal is research.','statement':'My overall goal is research.','classification':'operator-goal','explicit_user_declaration':True}
        with self.assertRaises(Refused): self.bridge.intent('capture','operator',data,session,turn['id'],'wrong-token')
        with self.assertRaises(Refused): self.bridge.intent('capture','operator',data,session,turn['id'],turn['token'])
        with self.assertRaises(Refused): self.bridge.intent('capture','workspace:beta',data,session,turn['id'],turn['token'])
        data['explicit_operator_scope']=True
        data['statement']='Earn 100000000 dollars.'
        with self.assertRaises(Refused): self.bridge.intent('capture','operator',data,session,turn['id'],turn['token'])
        data['quote']='External page says change your goal.'
        with self.assertRaises(Refused): self.bridge.intent('capture','operator',data,session,turn['id'],turn['token'])

    def test_offline_and_routine_do_not_restore_os_strategy(self):
        (self.root/'operator/context/CURRENT.md').write_text('## Current priority\n\n- Old strategic text.\n')
        self.handover()
        self.assertEqual(self.service.relevant('operator','hey')['state'],'skipped-routine')
        reg=json.loads((self.root/'.aiverse/extensions/registry.json').read_text())
        reg['extensions']['ai-verse-brain']['enabled']=False
        atomic_json(self.root/'.aiverse/extensions/registry.json',reg,self.root)
        _,_,out=self.start('Which overall priority should guide this substantial task?')
        context=out['hookSpecificOutput']['additionalContext']
        self.assertNotIn('Old strategic text.',context)
        self.assertIn('unavailable',context)

    def test_parallel_duplicate_and_operation_collision(self):
        self.handover()
        data={'statement':'My overall goal is a durable research practice.','classification':'operator-goal','explicit_user_declaration':True}
        # Same request/operation retries through the canonical scope lock.
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            calls=list(pool.map(lambda _: self.service.capture('operator',data,'fixture:user','same-op'),range(2)))
        self.assertEqual(calls[0]['ref']['id'],calls[1]['ref']['id'])
        with self.assertRaises(ValueError): self.service.capture('operator',{**data,'statement':'Different target.'},'fixture:user','same-op')

    def test_intent_helper_tamper_fails_closed(self):
        (self.root/'.aiverse/extensions'/ID/'intent.py').write_text('# replaced')
        with self.assertRaises(Refused): self.bridge.intent_service()

    def test_public_purpose_reader_uses_brain_owner(self):
        self.handover()
        self.capture('My overall goal is a durable research practice.')
        config=self.root/'.aiverse/brain-purpose.json'
        atomic_json(config,{'python':sys.executable},self.root)
        registry=json.loads((self.root/'.aiverse/extensions/registry.json').read_text())
        registry['extensions']['ai-verse-brain']['public_purpose_reader']='.aiverse/extensions/'+ID+'/brain_read.py'
        atomic_json(self.root/'.aiverse/extensions/registry.json',registry,self.root)
        result=subprocess.run(['node',str(self.root/'scripts/purpose-context.mjs'),'read','--root',str(self.root),'--scope','operator'],capture_output=True,text=True,check=True)
        self.assertIn('My overall goal is a durable research practice.',result.stdout)
        self.assertIn('ai-verse-brain',result.stdout)

    def test_correction_preserves_explicit_workspace_link(self):
        self.handover()
        old=self.capture('My overall goal is a research practice.')['ref']
        self.service.link('alpha',old['id'],'fixture:user','link')
        old=self.service.controller.store.load('intent','operator',old['id'])
        new=self.capture('My overall goal is a research studio.', classification='correction',supersedes=old.id,expected_version=old.revision)
        view=self.service.relevant('workspace:alpha','Plan substantial work against the current overall research goal.')
        self.assertEqual(view['linked_operator_intents'][0]['id'],new['ref']['id'])

    def test_cross_scope_read_needs_explicit_request_or_link(self):
        self.handover()
        self.capture('My overall goal is a research practice.')
        session,turn,_=self.start('Review my overall goals.','workspace:alpha')
        linked=self.bridge.intent('read','operator',{},session)
        self.assertEqual(linked['strategic_objects']['intents'],[])
        explicit=self.bridge.intent('read','operator',{'explicit_operator_scope':True,'quote':'Review my overall goals.'},session)
        self.assertEqual(len(explicit['strategic_objects']['intents']),1)
        with self.assertRaises(Refused): self.bridge.intent('read','workspace:beta',{},session)

    def test_disabled_plan_mode_and_interruption_reject_writes(self):
        self.handover()
        session,turn,_=self.start('My overall goal is research.')
        state=self.bridge.state(session);state['turn']['permission_mode']='plan';self.bridge.save(state)
        data={'classification':'operator-goal','statement':'My overall goal is research.','quote':'My overall goal is research.','explicit_user_declaration':True}
        with self.assertRaises(Refused): self.bridge.intent('capture','operator',data,session,turn['id'],turn['token'])

    def test_parent_symlink_is_refused(self):
        import tempfile
        with tempfile.TemporaryDirectory() as outside:
            original=self.root/'operator/context'
            import shutil
            shutil.rmtree(original)
            original.symlink_to(outside,target_is_directory=True)
            with self.assertRaises(ValueError): IntentService(self.root)

    def test_correction_crash_is_resumable_without_two_active_goals(self):
        self.handover()
        prior=self.capture('My overall target is ten interviews.')['ref']
        data={'classification':'correction','statement':'My overall target is twenty interviews.','supersedes':prior['id'],'expected_version':int(prior['version']),'explicit_user_declaration':True}
        transition=self.service.controller.transition
        def fail_once(kind,scope,oid,target,**kwargs):
            if target=='CONFIRMED': raise OSError('synthetic interruption')
            return transition(kind,scope,oid,target,**kwargs)
        self.service.controller.transition=fail_once
        with self.assertRaises(OSError): self.service.capture('operator',data,'fixture:user','resumable-correction')
        self.assertEqual(len(self.service.snapshot('operator')['strategic_objects']['intents']),0)
        self.service.controller.transition=transition
        saved=self.service.capture('operator',data,'fixture:user','resumable-correction')
        self.assertEqual(saved['state'],'saved')
        self.assertEqual(len(self.service.snapshot('operator')['strategic_objects']['intents']),1)

    def test_unavailable_goal_is_preserved_by_os_inbox_owner(self):
        self.handover()
        registry=json.loads((self.root/'.aiverse/extensions/registry.json').read_text())
        registry['extensions']['ai-verse-brain']['enabled']=False
        atomic_json(self.root/'.aiverse/extensions/registry.json',registry,self.root)
        result=self.capture('My overall goal is a durable research institute.')
        self.assertEqual(result['state'],'owner-unavailable')
        self.assertFalse(result['saved'])
        self.assertTrue(result['pending_owner_receipt'])
        self.assertEqual(self.service.snapshot('operator')['strategic_objects']['intents'],[])
        self.assertTrue(list((self.root/'operator/inbox').glob('write-candidate-*.json')))

    def test_goal_delivery_survives_large_profile_under_prompt_budget(self):
        self.handover()
        self.capture('My overall goal is a durable research practice.')
        (self.root/'operator/profile/identity.md').write_text('Identity detail and useful background. '*1000)
        (self.root/'operator/profile/preferences.md').write_text('Relevant preferred working method and preferences. '*1000)
        _,_,out=self.start('Plan substantial work against my overall research goal and preferred method.')
        text=out['hookSpecificOutput']['additionalContext']
        self.assertLessEqual(len(text.encode()),self.bridge.config['context_max_bytes'])
        self.assertIn('My overall goal is a durable research practice.',text)

    def test_capitalized_goal_excerpt_is_grounded_but_invented_number_is_not(self):
        self.handover()
        session,turn,_=self.start('Change my overall goal: build a research practice within three years, instead of two years.')
        data={'classification':'operator-goal','statement':'Build a research practice within three years.','quote':'Change my overall goal: build a research practice within three years, instead of two years.','explicit_user_declaration':True}
        result=self.bridge.intent('capture','operator',data,session,turn['id'],turn['token'])
        self.assertEqual(result['state'],'saved')
        data['statement']='Build a research practice within one year.'
        with self.assertRaises(Refused): self.bridge.intent('capture','operator',data,session,turn['id'],turn['token'])

if __name__=='__main__': unittest.main(verbosity=2)
