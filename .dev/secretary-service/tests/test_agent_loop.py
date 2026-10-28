"""Run with AstrBot's installed SDK. No provider, QQ or file I/O is invoked."""
import os
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, os.environ.get('SECRETARY_TEST_PLUGIN_ROOT', str(Path(__file__).parents[1] / 'integrations/astrbot')))
from astrbot_plugin_secretary.main import SecretaryPlugin
from astrbot_plugin_secretary.bridge import Turn

PROPOSAL = {'action_groups':[], 'clarification':None,'reply_intent':'discussion','discussion':'已读取。'}


class AgentLoopTests(unittest.IsolatedAsyncioTestCase):
    async def test_provider_error_is_not_a_user_answer_and_compose_cannot_send_it(self):
        async def behavior(_n,kwargs):
            return SimpleNamespace(role='err',completion_text='All chat models failed: PRIVATE-SENTINEL')
        plugin,turn,calls=self.make(behavior,native=True)
        with self.assertRaisesRegex(ValueError,'MODEL_PROVIDER_FAILED'):
            await plugin.run_secretary(turn)
        self.assertIsNone(turn.captured)
        with self.assertRaisesRegex(ValueError,'MODEL_PROVIDER_FAILED'):
            await plugin.compose_secretary({'facts':{},'instructions':'test'})

    async def test_context_overflow_rebases_once_preserving_effects_without_replaying_tools(self):
        writes=[]
        async def behavior(n,kwargs):
            if n==1:
                await kwargs['tools'].get_tool('workspace').handler(None,operation='write',path='03. Manual/test.md',content='saved')
                return SimpleNamespace(role='err',completion_text='MODEL_INPUT_LIMIT')
            if n==2:
                evidence=json.loads(kwargs['prompt'])['previous_effects']
                self.assertEqual(evidence[0]['result']['hash'],'sha256:test')
                return SimpleNamespace(role='assistant',completion_text='文件已保存。')
            return SimpleNamespace(role='assistant',completion_text='文件已保存。')
        plugin,turn,calls=self.make(behavior,native=True)
        async def post(_route,args):
            writes.append(args);return {'path':'03. Manual/test.md','hash':'sha256:test'}
        plugin.bridge.core_post=post
        await plugin.run_secretary(turn)
        self.assertEqual(len(writes),1)
        self.assertEqual(len(calls),3)
        self.assertEqual(turn.captured['discussion'],'文件已保存。')

    async def test_repeated_overflow_stops_after_one_rebase(self):
        async def behavior(_n,kwargs):
            return SimpleNamespace(role='err',completion_text='MODEL_INPUT_LIMIT')
        plugin,turn,calls=self.make(behavior,native=True)
        with self.assertRaisesRegex(ValueError,'MODEL_INPUT_LIMIT'):
            await plugin.run_secretary(turn)
        self.assertEqual(len(calls),2)
        self.assertIsNone(turn.captured)

    def make(self, behavior, limit=16, native=False):
        calls=[]
        class Context:
            platform_manager=SimpleNamespace(get_insts=lambda: [])
            async def tool_loop_agent(self, **kwargs):
                calls.append(kwargs)
                return await behavior(len(calls),kwargs)
        with patch.dict(os.environ, {'SECRETARY_BRIDGE_TOKEN':'test-token-'+'x'*40,'QQ_BOT_ID':'','SECRETARY_RECIPIENT':'','SECRETARY_CORE_URL':'http://test.invalid'}):
            plugin=SecretaryPlugin(Context())
        turn=Turn(plugin.bridge, {'input':{'id':'test','text':'明确的测试请求','channel':'qq'},
            'context':{},'instructions':'test','limits':{'max_tools':limit},
            'execution_mode':'tools-v2' if native else 'legacy'})
        return plugin,turn,calls

    async def test_native_loop_accepts_natural_answer_without_final_envelope_or_repair(self):
        async def behavior(n,kwargs):
            self.assertIsNone(kwargs['tools'].get_tool('submit_proposal'))
            if n==1:
                self.assertIsNotNone(kwargs['tools'].get_tool('secretary'))
                return SimpleNamespace(completion_text='四件事按刚才定的办，第二件改到下午三点。')
            self.assertIsNone(kwargs['tools'].get_tool('secretary'))
            self.assertIsNone(kwargs['tools'].get_tool('workspace'))
            return SimpleNamespace(completion_text='四件事都办好了，第二件改到下午三点。')
        plugin,turn,calls=self.make(behavior,native=True)
        await plugin.run_secretary(turn)
        self.assertEqual(len(calls),2)
        self.assertEqual(turn.captured['discussion'],'四件事都办好了，第二件改到下午三点。')
        self.assertEqual(turn.captured['language_review'],'done')
        self.assertEqual(turn.captured['action_groups'],[])

    async def test_native_business_rejection_and_correction_stay_inside_one_loop(self):
        seen=[]
        async def behavior(n,kwargs):
            if n>1:
                self.assertIsNone(kwargs['tools'].get_tool('secretary'))
                self.assertEqual(len(json.loads(kwargs['prompt'])['observed_tools']),2)
                return SimpleNamespace(completion_text='两件事都办妥了。')
            tool=kwargs['tools'].get_tool('secretary')
            for key in ('bad','fixed'):
                result=json.loads(await tool.handler(None,operation='apply_changes',action_groups=[{
                    'action_identity':key,'actions':[{'type':'create_task','title':'英语','outcome':'订正五题','acceptance':[{'kind':'check','description':'订正五题'}]}]}]))
                seen.append(result)
            return SimpleNamespace(completion_text='这两项都办妥了。')
        plugin,turn,calls=self.make(behavior,native=True)
        async def post(_route,args):
            return {'results':[{'status':'rejected','error':{'code':'INVALID_ACCEPTANCE'}}] if args['action_groups'][0]['action_identity']=='bad'
                else [{'status':'applied','operation_id':'op-1'}], 'updated_refs':[{'id':'task-1','version':1}]}
        plugin.bridge.core_post=post
        await plugin.run_secretary(turn)
        self.assertEqual(len(calls),2)
        self.assertEqual(seen[0]['results'][0]['status'],'rejected')
        self.assertEqual(seen[1]['results'][0]['status'],'applied')
        self.assertTrue(turn.has_mutation)
        self.assertEqual(turn.versions['task-1'],1)

    async def test_compose_really_calls_model_instead_of_echoing_a_canned_message(self):
        async def behavior(_n,kwargs):
            return SimpleNamespace(completion_text='资料A已经放在上次的位置，先接着第一段。')
        plugin,_turn,calls=self.make(behavior)
        text=await plugin.compose_secretary({'facts':{'message':'CANNED_SENTINEL'},'instructions':'only real facts'})
        self.assertEqual(len(calls),1)
        self.assertNotEqual(text,'CANNED_SENTINEL')
        self.assertEqual(text,'资料A已经放在上次的位置，先接着第一段。')

    async def test_failed_language_pass_keeps_original_llm_answer_and_cannot_replay_tools(self):
        async def behavior(n,kwargs):
            if n==1:return SimpleNamespace(completion_text='刚才那件事已按实际结果处理。')
            self.assertIsNone(kwargs['tools'].get_tool('secretary'))
            self.assertIsNone(kwargs['tools'].get_tool('workspace'))
            raise TimeoutError('language timeout')
        plugin,turn,calls=self.make(behavior,native=True)
        await plugin.run_secretary(turn)
        self.assertEqual(len(calls),2)
        self.assertEqual(turn.captured['discussion'],'刚才那件事已按实际结果处理。')
        self.assertEqual(turn.captured['language_review'],'original_llm_answer')

    async def test_language_pass_receives_recent_dialogue_without_full_private_context(self):
        async def behavior(n,kwargs):
            if n == 1:
                return SimpleNamespace(completion_text='先把单词材料打开。')
            rendered = json.loads(kwargs['prompt'])
            self.assertEqual([x['text'] for x in rendered['recent_interactions']], ['之前一', '之前二', '我不想做'])
            self.assertNotIn('private_document', rendered)
            self.assertIsNone(kwargs['tools'].get_tool('secretary'))
            return SimpleNamespace(completion_text='你是不想背单词，还是今天这个安排不合适？')
        plugin,turn,calls=self.make(behavior,native=True)
        turn.payload['context']={'recent_interactions':[{'text':s,'reply':''} for s in ['更早', '之前一', '之前二', '我不想做']], 'private_document':'do not forward'}
        await plugin.run_secretary(turn)
        self.assertEqual(len(calls),2)
        self.assertEqual(turn.captured['language_review'],'done')

    async def test_valid_submission_has_no_extra_loop(self):
        async def behavior(_n,kwargs):
            await kwargs['tools'].get_tool('submit_proposal').handler(None,**PROPOSAL)
            return SimpleNamespace(completion_text='')
        plugin,turn,calls=self.make(behavior)
        await plugin.run_secretary(turn)
        self.assertEqual(len(calls),1)
        self.assertEqual(turn.captured,PROPOSAL)

    async def test_structured_final_uses_the_same_validator_and_budget_without_replaying_tools(self):
        async def behavior(_n,kwargs):
            return SimpleNamespace(completion_text=json.dumps(PROPOSAL))
        plugin,turn,calls=self.make(behavior)
        await plugin.run_secretary(turn)
        self.assertEqual(len(calls),1)
        self.assertEqual(turn.captured,PROPOSAL)
        self.assertEqual(turn.used,1)

    async def test_missing_envelope_repairs_once_without_replaying_write(self):
        writes=[]
        async def behavior(n,kwargs):
            if n==1:
                await kwargs['tools'].get_tool('workspace').handler(None,operation='write',path='03. Manual/test.md',content='合成内容',base_hash='sha256:test')
                return SimpleNamespace(completion_text='文件已写入')
            self.assertIsNone(kwargs['tools'].get_tool('workspace'))
            self.assertIsNone(kwargs['tools'].get_tool('secretary'))
            self.assertLessEqual(kwargs['max_steps'],2)
            await kwargs['tools'].get_tool('submit_proposal').handler(None,**PROPOSAL)
            return SimpleNamespace(completion_text='')
        plugin,turn,calls=self.make(behavior)
        async def post(route,args):
            writes.append((route,args))
            return {'path':'03. Manual/test.md','hash':'sha256:test'}
        plugin.bridge.core_post=post
        await plugin.run_secretary(turn)
        self.assertEqual(len(calls),2)
        self.assertEqual(len(writes),1)
        self.assertEqual(turn.captured,PROPOSAL)

    async def test_exhausted_budget_does_not_start_another_loop(self):
        async def behavior(_n,kwargs):
            for _ in range(2):
                await kwargs['tools'].get_tool('get_context').handler(None,ids=[],purpose='test')
            return SimpleNamespace(completion_text='没有最终提交')
        plugin,turn,calls=self.make(behavior,limit=2)
        await plugin.run_secretary(turn)
        self.assertEqual(len(calls),1)
        self.assertIsNone(turn.captured)

    async def test_repair_is_bounded_and_cannot_replay_mutations_even_if_the_model_ignores_submission(self):
        async def behavior(n,kwargs):
            if n>1:
                self.assertIsNone(kwargs['tools'].get_tool('workspace'))
                self.assertIsNone(kwargs['tools'].get_tool('secretary'))
                self.assertLessEqual(kwargs['max_steps'],2)
            return SimpleNamespace(completion_text='普通文字不能伪装成已执行业务')
        plugin,turn,calls=self.make(behavior)
        await plugin.run_secretary(turn)
        self.assertEqual(len(calls),3) # One ordinary loop, at most two envelope-only repairs.
        self.assertIsNone(turn.captured)


if __name__=='__main__':
    unittest.main()
