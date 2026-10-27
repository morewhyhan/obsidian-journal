import os
import json
import asyncio
import time

from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register
from astrbot.core.agent.tool import FunctionTool, ToolSet
from astrbot.core.platform.astrbot_message import AstrBotMessage, MessageMember
from astrbot.core.platform.message_type import MessageType
from astrbot.core.platform.platform_metadata import PlatformMetadata

from .bridge import Bridge
from .model_contract import model_tool_definition, result_text, effect_context, model_view


class IsolatedEvent(AstrMessageEvent):
    """Internal tool turn cannot send directly or acquire QQ permissions."""

    async def send(self, _message):
        raise PermissionError("DIRECT_SEND_FORBIDDEN")


@register("astrbot_plugin_secretary", "morewhyhan", "受限私人秘书Core", "1.0.0")
class SecretaryPlugin(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        self.platform_manager = context.platform_manager
        self.bridge = Bridge(
            self,
            os.environ["SECRETARY_BRIDGE_TOKEN"],
            os.getenv("SECRETARY_CORE_URL", "http://core:3180"),
            os.getenv("QQ_BOT_ID", ""),
            os.getenv("SECRETARY_RECIPIENT", ""),
        )

    async def initialize(self):
        await self.bridge.start()

    @filter.event_message_type(filter.EventMessageType.ALL, priority=10000)
    async def forward(self, event: AstrMessageEvent):
        await self.bridge.receive(event)

    async def run_secretary(self, turn):
        payload = turn.payload
        message = AstrBotMessage()
        message.type = MessageType.FRIEND_MESSAGE
        message.self_id = "core"
        message.message_id = payload["input"]["id"]
        message.sender = MessageMember(user_id="core", nickname="Core")
        message.message = []
        message.message_str = payload["input"]["text"]
        event = IsolatedEvent(
            message.message_str, message,
            PlatformMetadata(name="secretary", description="Core internal turn", id="secretary-internal"),
            payload["input"]["id"],
        )
        tools = ToolSet()
        observed = []
        native = turn.native
        model_context=model_view(payload['context'])
        if native and 'assistant' in model_context:
            # These objects already have their own items/plans/proposals/work sections.
            model_context['assistant'].pop('board',None)
        if native:
            model_context['application']={'lookup':'secretary.capabilities列能力；query填具体动作type查字段。'}
        began = time.monotonic()
        async def capture_structured_response(response):
            if turn.captured is not None or turn.used >= turn.limit:
                return
            text = str(getattr(response, "completion_text", "") or "").strip()
            if text.startswith("```json\n") and text.endswith("```"):
                text = text[8:-3].strip()
            try:
                proposal = json.loads(text)
            except (ValueError, TypeError):
                return
            if not isinstance(proposal, dict):
                return
            # Same budget, schema and semantic checks as the tool transport.
            # Ordinary prose is never interpreted as an execution receipt.
            result = await turn.call("submit_proposal", proposal)
            observed.append({"tool": "submit_proposal", "result": result})
        for definition in self.bridge.tools:
            name = definition["name"]
            if payload["input"].get("id") == "model-self-test" and name != "submit_proposal":
                continue
            if native and name == 'submit_proposal':
                continue
            definition = model_tool_definition(definition, native, bool(payload.get('context', {}).get('background_grant')))
            if name == 'secretary':
                definition['description'] += ' 具体业务动作首次使用时先capabilities查询，query填动作type，得到所需字段与约束后再提交。'

            def handler_for(tool_name):
                async def handler(_event, **args):
                    result = await turn.call(tool_name, args)
                    observed.append({"tool": tool_name, "arguments": args, "result": result})
                    return result
                return handler

            tools.add_tool(FunctionTool(
                name=name,
                description=definition["description"],
                parameters=definition["parameters"],
                handler=handler_for(name),
            ))
        scope = ("\n本次是Core主动规划，只用提供的目标片段和只读业务数据；不得调用workspace、preferences、status或写入文件。新增承诺用提案，clarification非空时reply_intent必须为clarification。"
            if payload["input"].get("channel") == "coordinator" else "")
        if native and payload.get("context", {}).get("background_grant"):
            scope = "\n本次是受限后台委托，只使用当前work与Core签发范围。允许按工具结果查证和办理，不能自签权限、改变验收或扩大对象；需要决定先保存waiting_user。不要直接联系用户，最后说明真实效果。"
        if payload["input"].get("id") == "model-self-test":
            scope = "\n本次仅协议自检，不读取任何工具或文件；只提交一次discussion=ready、clarification=null、action_groups=[]。"
        final = await self.context.tool_loop_agent(
            event=event,
            chat_provider_id="secretary-deepseek",
            prompt=json.dumps({"input": payload["input"], "context": model_context}, ensure_ascii=False, separators=(',', ':')),
            system_prompt=payload["instructions"] + ("\n本轮为自主助理执行。结合完整上下文理解用户，不按关键词或固定轮次办事。自主调用现有工具并查看真实结果，必要时修正再继续。secretary.apply_changes办理已明确交代的操作；resolve_proposals处理原建议，save_proposals只存未定建议。复述使用当前已谈妥版本，用户整体认可后一次落实，不逐项再问。工具结果是事实依据；没有执行不报成功。最后直接用自然语言回复，不输出JSON、不暴露协议或固定口令。" if native else "\n只使用本次提供的四个工具。直接查找文件和原生应用能力，不要求用户粘贴文件。必须用submit_proposal提交最终回答，接收提案不代表执行。只讨论能力时不创建。新建周期笔记必须secretary.create_period。") + scope,
            tools=tools,
            contexts=[],
            max_steps=turn.limit + 1,
            tool_call_timeout=30,
            stream=False,
        )
        if native:
            try:
                text = result_text(final)
            except ValueError as failure:
                # A bounded fresh SDK context removes accumulated provider reasoning, not
                # business results. Same input + Core semantic idempotency forbids replay.
                remaining = payload.get('limits', {}).get('timeout_ms',120000)/1000-(time.monotonic()-began)
                if str(failure) not in {'MODEL_INPUT_LIMIT','MODEL_INVALID_FINAL'} or remaining<10 or turn.used>=turn.limit:
                    raise
                final = await self.context.tool_loop_agent(event=event, chat_provider_id='secretary-deepseek',
                    prompt=json.dumps({'input':payload['input'],'context':model_context,
                        'previous_effects':model_view(effect_context(observed)),'continuation_reason':str(failure)},ensure_ascii=False,separators=(',',':')),
                    system_prompt=payload['instructions']+scope+'\n同一个交代的有限接续。依据previous_effects保留已成功结果，不重新执行成功组；只纠正明确未执行的部分，unknown先查询。用实际工具办理，不在正文写DSML或工具代码。不需要用户重复交代。当前明确指令的执行依据由Core自动绑定。',
                    tools=tools,contexts=[],max_steps=turn.limit-turn.used+1,tool_call_timeout=30,stream=False)
                text=result_text(final)
            # The planner saw schemas, IDs and operational errors. Let a short,
            # tool-free language pass speak to the user using the same real
            # evidence, without replaying actions or making up a canned reply.
            remaining = payload.get('limits', {}).get('timeout_ms', 120000) / 1000 - (time.monotonic() - began)
            turn.language_review = 'skipped_budget'
            if remaining > 2:
                try:
                    async with asyncio.timeout(min(12, remaining - 0.5)):
                        rendered = await self.context.tool_loop_agent(
                            event=event, chat_provider_id='secretary-deepseek',
                            prompt=json.dumps({'request':payload['input'],
                                'draft':text, 'observed_tools':effect_context(observed)},ensure_ascii=False,separators=(',',':')),
                            system_prompt=payload['instructions'] + '\n本次只负责发给用户的最终表达，不能调用工具或执行任何动作。原draft可能啰嗦或有推断，以实际工具结果和用户原话为准。保留必要的完整核对或真正缺少的信息；不新增邀请、不教用户回复口令、不追问已经说清的问题。办妥通常一两句，核对多件事可以短列表；避免内部版本、ID、台账、工具协议和反复声明没有什么。不要把计划、工具已执行、用户已经行动混成一回事，用户未自报开始就不能说已经开始。用户明确要原文或细节时保留，不为了简短漏掉部分失败。像熟悉事情的助理自然说话，直接给正文。',
                            tools=ToolSet(), contexts=[], max_steps=1, tool_call_timeout=30, stream=False)
                        polished = result_text(rendered)
                        if not polished or len(polished)>12000: raise ValueError('INVALID_LANGUAGE')
                        text=polished;turn.language_review='done'
                except (Exception, TimeoutError):
                    # The fallback is the original LLM answer, never Core prose.
                    turn.language_review='original_llm_answer'
            turn.captured = {'action_groups':[], 'clarification':None,
                'reply_intent':'receipt' if turn.has_mutation else 'discussion', 'discussion':text,
                'language_review':turn.language_review}
            return
        await capture_structured_response(final)
        for _repair in range(2):
            if turn.captured is not None or turn.used >= turn.limit:
                break
            # Repair only the missing final envelope. The first loop's file
            # operations must never be replayed; this continuation can only
            # submit a proposal using the facts already observed.
            final_tools = ToolSet()
            final_tools.add_tool(tools.get_tool("submit_proposal"))
            final = await self.context.tool_loop_agent(
                event=event,
                chat_provider_id="secretary-deepseek",
                prompt=json.dumps({
                    "input": payload["input"], "context": payload["context"],
                    "draft": getattr(final, "completion_text", ""),
                    "observed_tools": json.dumps(observed, ensure_ascii=False)[-12000:],
                }, ensure_ascii=False),
                system_prompt=payload["instructions"] + scope +
                    "\n上轮未提交最终契约。本次只补交submit_proposal，不重做任何操作。"
                    "读取或拒绝访问的回答用空action_groups和discussion；业务变更仍只是提案，"
                    "没有工具成功不声称执行。首选调用唯一工具提交；如果没有发出工具调用，"
                    "只输出同一submit_proposal契约的完整JSON对象（action_groups/clarification/reply_intent/discussion），不要输出普通文字。",
                # A thinking provider may choose a structured final response
                # instead of a function call. Both cross the same validator.
                tools=final_tools, contexts=[], max_steps=2,
                tool_call_timeout=30, stream=False,
            )
            await capture_structured_response(final)

    async def compose_secretary(self, payload):
        message = AstrBotMessage()
        message.type = MessageType.FRIEND_MESSAGE
        message.self_id = 'core'
        message.message_id = 'compose'
        message.sender = MessageMember(user_id='core', nickname='Core')
        message.message = []
        message.message_str = '根据真实事实组织一条助理消息'
        event = IsolatedEvent(message.message_str, message,
            PlatformMetadata(name='secretary', description='Core internal language', id='secretary-internal'), 'compose')
        answer = await self.context.tool_loop_agent(event=event,
            chat_provider_id='secretary-deepseek',
            prompt=json.dumps(payload.get('facts', {}), ensure_ascii=False),
            system_prompt=payload.get('instructions', '') + '\n现在只生成一条要发给用户的自然语言消息，不执行操作。依据给出的真实状态、用途、用户偏好和当下语境表达。内部草稿只是事实线索，不照抄固定提示。简短像熟悉工作的助理，不列能力清单、不说教、不追加无必要问题。准确保留时间、数量、失败与未知；不能把提醒或建议说成用户已做或操作已成功。直接输出消息正文，不输出JSON。',
            tools=ToolSet(), contexts=[], max_steps=1, tool_call_timeout=30, stream=False)
        return result_text(answer)

    async def terminate(self):
        await self.bridge.close()
