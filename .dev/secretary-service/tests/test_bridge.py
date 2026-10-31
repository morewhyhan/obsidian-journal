"""Run with the existing AstrBot bridge requirements; no QQ connection or model calls."""
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import AsyncMock

module_path = (Path(os.environ['SECRETARY_TEST_PLUGIN_ROOT']) / 'astrbot_plugin_secretary/bridge.py'
    if os.environ.get('SECRETARY_TEST_PLUGIN_ROOT') else Path(__file__).parents[1] / "integrations/astrbot/astrbot_plugin_secretary/bridge.py")
spec = importlib.util.spec_from_file_location("secretary_bridge_test", module_path)
bridge_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge_module)

class ToolRecovery(unittest.IsolatedAsyncioTestCase):
    async def test_wrong_entity_and_ignored_planning_fields_are_corrected_before_capture(self):
        turn,bridge=self.turn()
        turn.observe_versions({'tasks':[{'id':'task-x','version':2}],
            'plans':[{'id':'plan-x','version':3,'target_ref':{'id':'task-x','kind':'task'},'window_start':'2026-10-26T02:00:00Z'}]})
        action={'type':'reschedule','target_id':'task-x','expected_version':2,
            'window_start':'2026-10-26T02:00:00Z','window_end':'2026-10-26T03:00:00Z'}
        proposal={'action_groups':[{'action_identity':'move','actions':[action]}],'clarification':None,'reply_intent':'receipt'}
        rejected=json.loads(await turn.call('submit_proposal',proposal))
        self.assertEqual(rejected['error']['code'],'PLAN_TARGET_REQUIRED')
        self.assertIsNone(turn.captured)
        action['target_id']='plan-x'
        rejected=json.loads(await turn.call('submit_proposal',proposal))
        self.assertEqual(rejected['error']['expected_version'],3)
        action['expected_version']=3
        await turn.call('submit_proposal',proposal)
        self.assertEqual(turn.captured,proposal)
        turn,bridge=self.turn()
        action={'type':'update_task','target_id':'task-x','expected_version':2,'next_action':'打开词表A'}
        proposal['action_groups'][0]['actions']=[action]
        rejected=json.loads(await turn.call('submit_proposal',proposal))
        self.assertEqual(rejected['error']['code'],'TOOL_VALIDATION_FAILED')
        self.assertEqual(rejected['error']['constraint'],'enum')
        self.assertIsNone(turn.captured)
        action['planning']={'next_action':action.pop('next_action')}
        await turn.call('submit_proposal',proposal)
        self.assertEqual(turn.captured,proposal)

    async def test_new_task_deadline_and_initial_plan_must_be_consistent_before_capture(self):
        turn,bridge=self.turn()
        task={'type':'create_task','title':'词汇','outcome':'订正五个词','status':'ready',
            'due_at':'2026-10-26T03:00:00+08:00',
            'acceptance':[{'id':'five','kind':'check','description':'订正五个词'}],
            'initial_plan':{'window_start':'2026-10-26T10:00:00+08:00','window_end':'2026-10-26T10:20:00+08:00',
                'duration_minutes':20,'next_action':'打开词表A','kind':'window'}}
        proposal={'action_groups':[{'action_identity':'vocabulary','actions':[task]}],
            'clarification':None,'reply_intent':'receipt'}
        rejected=json.loads(await turn.call('submit_proposal',proposal))
        self.assertEqual(rejected['error']['code'],'DEADLINE_WINDOW_CONFLICT')
        self.assertIsNone(turn.captured)
        task['due_at']='2026-10-26T11:00:00+08:00'
        await turn.call('submit_proposal',proposal)
        self.assertEqual(turn.captured,proposal)
        bridge.core_post.assert_not_awaited()

    async def test_empty_receipt_must_be_corrected_before_it_can_claim_execution(self):
        turn,bridge=self.turn()
        proposal={'action_groups':[],'clarification':None,'reply_intent':'receipt','discussion':'已设置Hello提醒'}
        rejected=json.loads(await turn.call('submit_proposal',proposal))
        self.assertEqual(rejected['error']['code'],'EMPTY_EXECUTION_RECEIPT')
        self.assertIsNone(turn.captured)
        proposal['action_groups']=[{'action_identity':'hello','actions':[{'type':'create_automation','kind':'one_shot','title':'Hello','body':'Hello','delay_seconds':30}]}]
        await turn.call('submit_proposal',proposal)
        self.assertEqual(turn.captured,proposal)
        bridge.core_post.assert_not_awaited()

    async def test_model_cannot_invent_a_manual_binding_instead_of_automatic_diary_projection(self):
        turn,bridge=self.turn()
        proposal={'action_groups':[{'action_identity':'wrong-binding','actions':[{
            'type':'link_diary','target_id':'task-x','expected_version':1,'path':'03. Manual/method.md','label':'入口'}]}],
            'clarification':None,'reply_intent':'receipt'}
        rejected=json.loads(await turn.call('submit_proposal',proposal))
        self.assertEqual(rejected['error']['code'],'TOOL_VALIDATION_FAILED')
        self.assertIsNone(turn.captured)
        bridge.core_post.assert_not_awaited()

    async def test_all_actions_use_the_observed_transaction_snapshot_not_guessed_future_versions(self):
        turn,bridge=self.turn()
        turn.observe_versions({'items':[{'id':'task-x','version':3}]})
        proposal={'action_groups':[{'action_identity':'update','actions':[
            {'type':'update_task','target_id':'task-x','expected_version':3,'due_at':'2026-10-26T10:00:00Z'},
            {'type':'configure_task','target_id':'task-x','expected_version':4,'planning':{'next_action':'打开词表'}}]}],
            'clarification':None,'reply_intent':'receipt'}
        rejected=json.loads(await turn.call('submit_proposal',proposal))
        self.assertEqual(rejected['error']['code'],'VERSION_SNAPSHOT_REQUIRED')
        self.assertEqual(rejected['error']['expected_version'],3)
        self.assertIsNone(turn.captured)
        proposal['action_groups'][0]['actions'][1]['expected_version']=3
        await turn.call('submit_proposal',proposal)
        self.assertEqual(turn.captured,proposal)
        bridge.core_post.assert_not_awaited()

    async def test_failure_diagnostics_keep_categories_without_raw_private_messages(self):
        import aiohttp
        class BrokenContext:
            async def run_secretary(self, _turn):
                raise ValueError('PRIVATE_MODEL_KEY_AND_NOTE_CONTENT')
        bridge=bridge_module.Bridge(BrokenContext(),'x'*40,'http://test.invalid','','')
        bridge.core_post=AsyncMock(return_value={'id':'test-model-job'})
        try:
            site=await bridge.start(host='127.0.0.1',port=0)
            port=site._server.sockets[0].getsockname()[1]
            async with aiohttp.ClientSession(headers={'Authorization':'Bearer '+'x'*40}) as client:
                async with client.post(f'http://127.0.0.1:{port}/interpret',json={'input':{'id':'test'}}) as response:
                    value=await response.json()
                    self.assertEqual(response.status,503)
                    self.assertEqual(value['error']['code'],'BRIDGE_UNAVAILABLE')
                    self.assertEqual(value['error']['reason'],'ValueError')
                    self.assertNotIn('PRIVATE',json.dumps(value))
                self.assertNotIn('PRIVATE',json.dumps(bridge.last_failure))
                self.assertEqual(bridge.core_post.await_args_list[0].args[0],'/internal/model/jobs/start')
                self.assertEqual(bridge.core_post.await_args_list[-1].args[0],'/internal/model/jobs/end')
        finally:
            await bridge.close()

    async def test_rule_values_and_hourly_kind_are_checked_before_final_submission(self):
        turn, bridge = self.turn()
        proposal = {'action_groups':[{'action_identity':'style','actions':[{
            'type':'set_personal_rule','key':'contact.style','value':{'instruction':'温和'},'expected_rules_revision':0}]}],
            'clarification':None,'reply_intent':'receipt'}
        rejected=json.loads(await turn.call('submit_proposal',proposal))
        self.assertEqual(rejected['error']['code'],'TOOL_VALIDATION_FAILED')
        self.assertTrue(rejected['error']['path'].endswith('value'))
        self.assertEqual(rejected['error']['expected'],'string')
        self.assertIsNone(turn.captured)
        proposal['action_groups'][0]['actions'][0]['value']='温和简短'
        await turn.call('submit_proposal',proposal)
        self.assertEqual(turn.captured,proposal)
        turn,bridge=self.turn()
        automation={'type':'create_automation','kind':'recurring','title':'小时回顾',
            'schedule':{'weekdays':[1,2,3,4,5],'starts_on':'2026-10-26','local_start':'09:00','local_end':'18:00','minute':55}}
        proposal['action_groups'][0]['actions']=[automation]
        rejected=json.loads(await turn.call('submit_proposal',proposal))
        self.assertEqual(rejected['error']['code'],'TOOL_VALIDATION_FAILED')
        self.assertIsNone(turn.captured)
        automation['kind']='hourly_checkin'
        await turn.call('submit_proposal',proposal)
        self.assertEqual(turn.captured,proposal)
        bridge.core_post.assert_not_awaited()
        turn,bridge=self.turn()
        proposal['action_groups'][0]['actions']=[{'type':'create_automation','kind':'one_shot','title':'Hello',
            'delay_seconds':30,'due_at':'2026-10-26T02:00:00Z'}]
        rejected=json.loads(await turn.call('submit_proposal',proposal))
        self.assertEqual(rejected['error']['code'],'TOOL_VALIDATION_FAILED')
        self.assertIsNone(turn.captured)
        del proposal['action_groups'][0]['actions'][0]['due_at']
        await turn.call('submit_proposal',proposal)
        self.assertEqual(turn.captured,proposal)

    async def test_habit_minimum_must_be_explicit_in_model_contract(self):
        turn, bridge = self.turn()
        habit = {'type':'create_habit','title':'背词','min_behavior':'背10个词',
            'recurrence':{'weekdays':[1,2,3,4,5,6,7],'starts_on':'2026-10-26'},
            'anchor':{'kind':'time_window','local_start':'10:00','local_end':'10:20'},
            'reminder_mode':'window'}
        proposal={'action_groups':[{'action_identity':'habit','actions':[habit]}],
            'clarification':None,'reply_intent':'receipt'}
        invalid=json.loads(await turn.call('submit_proposal',proposal))
        self.assertEqual(invalid['error']['code'],'TOOL_VALIDATION_FAILED')
        habit['minimum_quantity']={'value':10,'unit':'词'}
        await turn.call('submit_proposal',proposal)
        self.assertEqual(turn.captured,proposal)
        bridge.core_post.assert_not_awaited()

    def turn(self):
        bridge = type("FakeBridge", (), {})()
        bridge.tools = json.loads(module_path.with_name("tools.json").read_text("utf-8-sig"))
        bridge.core_post = AsyncMock(side_effect=[ValueError("PLANNING_SCOPE"), {"items": []}])
        return bridge_module.Turn(bridge, {"input": {"id": "isolated-test"}, "context": {}, "limits": {"max_tools": 6}}), bridge

    async def test_rejected_scope_returns_feedback_and_cannot_execute_before_a_corrected_query(self):
        turn, bridge = self.turn()
        rejected = json.loads(await turn.call("secretary", {"operation": "preferences"}))
        self.assertEqual(rejected["error"]["code"], "PLANNING_SCOPE")
        self.assertIsNone(turn.captured)
        accepted = json.loads(await turn.call("secretary", {"operation": "planning"}))
        self.assertEqual(accepted, {"items": []})
        self.assertEqual(bridge.core_post.await_count, 2)

    async def test_invalid_proposal_can_be_corrected_without_losing_the_turn_or_increasing_permissions(self):
        turn, bridge = self.turn()
        proposal = {"action_groups": [], "clarification": "明天用哪个时段？", "reply_intent": "discussion"}
        invalid = json.loads(await turn.call("submit_proposal", proposal))
        self.assertEqual(invalid["error"]["code"], "CLARIFICATION_INTENT")
        self.assertIsNone(turn.captured)
        proposal["reply_intent"] = "clarification"
        await turn.call("submit_proposal", proposal)
        self.assertEqual(turn.captured, proposal)
        duplicate = json.loads(await turn.call("secretary", {"operation": "planning"}))
        self.assertEqual(duplicate["error"]["code"], "PROPOSAL_ALREADY_SUBMITTED")
        bridge.core_post.assert_not_awaited()

    async def test_schema_error_is_recoverable_but_the_tool_budget_is_still_enforced(self):
        turn, bridge = self.turn()
        turn.limit = 2
        result = json.loads(await turn.call("secretary", {}))
        self.assertEqual(result["error"]["code"], "TOOL_VALIDATION_FAILED")
        await turn.call("get_context", {"ids": []})
        with self.assertRaisesRegex(ValueError, "TOOL_LIMIT"):
            await turn.call("get_context", {"ids": []})
        bridge.core_post.assert_not_awaited()

if __name__ == "__main__": unittest.main()


class NativeToolSet(unittest.TestCase):
    """A native turn answers in prose, so the legacy proposal schema is dropped."""

    def bridge(self):
        return bridge_module.Bridge(
            None, "x" * 40, "http://core:3180", "1000000001", "1000000002"
        )

    def test_native_turns_do_not_carry_the_duplicated_proposal_schema(self):
        bridge = self.bridge()
        native = [tool["name"] for tool in bridge.tools_for(True)]
        legacy = [tool["name"] for tool in bridge.tools_for(False)]
        self.assertNotIn("submit_proposal", native)
        self.assertIn("secretary", native)
        self.assertIn("workspace", native)
        self.assertIn("get_context", native)
        self.assertIn("submit_proposal", legacy)
        # The legacy protocol probe answers through submit_proposal.
        self.assertEqual(len(bridge.tools_for(False, True)), len(legacy))
        # The catalog hash still covers every shipped tool.
        self.assertEqual(
            len(bridge.tools), len(legacy)
        )
        self.assertGreater(len(legacy), len(native))

class RepeatedReadLoop(unittest.IsolatedAsyncioTestCase):
    async def test_an_identical_read_is_answered_from_the_turn_memo(self):
        bridge = type("FakeBridge", (), {})()
        bridge.tools = json.loads(module_path.with_name("tools.json").read_text("utf-8-sig"))
        bridge.core_post = AsyncMock(return_value={"items": [{"id": "task-1"}]})
        turn = bridge_module.Turn(
            bridge,
            {"input": {"id": "loop-probe"}, "context": {}, "limits": {"max_tools": 6}},
        )
        first = json.loads(await turn.call("secretary", {"operation": "state"}))
        second = json.loads(await turn.call("secretary", {"operation": "state"}))
        self.assertEqual(first, second["result"])
        self.assertTrue(second["repeat"])
        self.assertIn("不要重复同一调用", second["notice"])
        # One physical call only: the repeat is served from the turn memo.
        self.assertEqual(bridge.core_post.await_count, 1)
        # A different read still reaches Core.
        await turn.call("secretary", {"operation": "status"})
        self.assertEqual(bridge.core_post.await_count, 2)
