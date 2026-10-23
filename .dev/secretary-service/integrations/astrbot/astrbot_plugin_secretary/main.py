import os
import json

from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register
from astrbot.core.agent.tool import FunctionTool, ToolSet
from astrbot.core.platform.astrbot_message import AstrBotMessage, MessageMember
from astrbot.core.platform.message_type import MessageType
from astrbot.core.platform.platform_metadata import PlatformMetadata

from .bridge import Bridge


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
        for definition in self.bridge.tools:
            name = definition["name"]

            def handler_for(tool_name):
                async def handler(_event, **args):
                    return await turn.call(tool_name, args)
                return handler

            tools.add_tool(FunctionTool(
                name=name,
                description=definition["description"],
                parameters=definition["parameters"],
                handler=handler_for(name),
            ))
        await self.context.tool_loop_agent(
            event=event,
            chat_provider_id="secretary-deepseek",
            prompt=json.dumps({"input": payload["input"], "context": payload["context"]}, ensure_ascii=False),
            system_prompt=payload["instructions"] + "\n只使用本次提供的四个工具。直接查找文件和原生应用能力，不要求用户粘贴文件。必须用submit_proposal提交最终回答，接收提案不代表执行。只讨论能力时不创建。新建周期笔记必须secretary.create_period。",
            tools=tools,
            contexts=[],
            max_steps=turn.limit + 1,
            tool_call_timeout=30,
            stream=False,
        )

    async def terminate(self):
        await self.bridge.close()
