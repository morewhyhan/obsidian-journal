"""Request-scoped tools and authenticated transport; no vault filesystem access."""

import asyncio
import hmac
import json
import time
import uuid
from pathlib import Path

import aiohttp
import jsonschema
from aiohttp import web


class Turn:
    def __init__(self, bridge, payload):
        self.bridge = bridge
        self.payload = payload
        self.captured = None
        self.used = 0
        self.limit = min(24, max(2, payload.get("limits", {}).get("max_tools", 16)))

    async def call(self, name, args):
        self.used += 1
        if self.used > self.limit:
            raise ValueError("TOOL_LIMIT")
        if self.captured is not None:
            raise ValueError("PROPOSAL_ALREADY_SUBMITTED")
        definition = next(t for t in self.bridge.tools if t["name"] == name)
        try:
            jsonschema.validate(args, definition["parameters"])
        except jsonschema.ValidationError:
            # Return only the contract path, never arguments or private content.
            raise ValueError("TOOL_VALIDATION_FAILED: check required fields and enums") from None
        if name == "submit_proposal":
            if args.get("clarification") and args["reply_intent"] != "clarification":
                raise ValueError("CLARIFICATION_INTENT")
            if not args["action_groups"] and not any(
                str(args.get(k) or "").strip() for k in ("discussion", "summary", "clarification")
            ):
                raise ValueError("EMPTY_ANSWER")
            self.captured = args
            return "提案已接收，尚未执行；由Core实际结果生成回执。"
        if name == "get_context":
            context = self.payload["context"]
            ids = args["ids"]
            return json.dumps({
                "items": [x for x in context.get("items", []) if not ids or x["id"] in ids],
                "now": context.get("now"), "business_date": context.get("business_date"),
            }, ensure_ascii=False)
        endpoint = {"secretary": "application", "workspace": "workspace"}[name]
        result = await self.bridge.core_post("/internal/" + endpoint, {
            **args, "input_id": self.payload["input"]["id"], "call_id": uuid.uuid4().hex,
        })
        return json.dumps(result, ensure_ascii=False)


class Bridge:
    def __init__(self, context, token, core_url, bot_id, owner_id, platform_id="secretary-qq"):
        if len(token) < 32:
            raise ValueError("BRIDGE_TOKEN_REQUIRED")
        if bot_id and owner_id and bot_id == owner_id:
            raise ValueError("BOT_AND_OWNER_MUST_DIFFER")
        self.context = context
        self.token = token
        self.core_url = core_url.rstrip("/")
        self.bot_id, self.owner_id, self.platform_id = bot_id, owner_id, platform_id
        self.tools = json.loads(Path(__file__).with_name("tools.json").read_text("utf-8-sig"))
        self.lock = asyncio.Lock()
        self.session = None
        self.runner = None
        self.last_event = None
        self.sends = {}  # bounded duplicate protection; Core owns durable claims

    async def core_post(self, route, payload):
        async with self.session.post(
            self.core_url + route, json=payload, allow_redirects=False,
            headers={"Authorization": "Bearer " + self.token},
        ) as response:
            value = await response.json()
            if response.status >= 300:
                raise ValueError(value.get("error", {}).get("code", "CORE_REJECTED"))
            return value

    async def start(self, host="0.0.0.0", port=3181):
        self.session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30))

        @web.middleware
        async def auth(request, handler):
            if not hmac.compare_digest(request.headers.get("Authorization", ""), "Bearer " + self.token):
                return web.json_response({"error": {"code": "FORBIDDEN"}}, status=403)
            try:
                return await handler(request)
            except (asyncio.TimeoutError, TimeoutError):
                return web.json_response({"error": {"code": "BRIDGE_TIMEOUT"}}, status=503)
            except Exception:
                return web.json_response({"error": {"code": "BRIDGE_UNAVAILABLE"}}, status=503)

        app = web.Application(middlewares=[auth], client_max_size=150000)
        app.router.add_get("/healthz", self.health)
        app.router.add_post("/interpret", self.interpret)
        app.router.add_post("/compose", self.compose)
        app.router.add_post("/send", self.send)
        self.runner = web.AppRunner(app, access_log=None)
        await self.runner.setup()
        site = web.TCPSite(self.runner, host, port)
        await site.start()
        return site

    def client(self):
        for platform in self.context.platform_manager.get_insts():
            if platform.meta().id == self.platform_id and platform.meta().name == "aiocqhttp":
                return platform.get_client()
        return None

    async def channel_health(self):
        client = self.client()
        connected = False
        if client and self.bot_id and self.owner_id:
            try:
                async with asyncio.timeout(2):
                    login = await client.call_action("get_login_info", self_id=int(self.bot_id))
                    status = await client.call_action("get_status", self_id=int(self.bot_id))
                    connected = str(login.get("user_id")) == self.bot_id and status.get("online") is True
            except Exception:
                pass
        return {"connected": connected, "bound": bool(self.owner_id), "lastEventAt": self.last_event, "transport": "astrbot-napcat"}

    async def health(self, _request):
        return web.json_response({"ok": True, "agent": "astrbot", "qq": await self.channel_health()})

    async def interpret(self, request):
        payload = await request.json()
        if self.lock.locked():
            return web.json_response({"error": {"code": "AGENT_BUSY"}}, status=429)
        async with self.lock:
            timeout = min(120, max(10, payload.get("limits", {}).get("timeout_ms", 120000) / 1000))
            turn = Turn(self, payload)
            async with asyncio.timeout(timeout):
                await self.context.run_secretary(turn)
            if turn.captured is None:
                raise ValueError("AGENT_INVALID")
            return web.json_response(turn.captured)

    async def compose(self, request):
        # Deterministic execution receipts cannot invent success or erase warnings.
        payload = await request.json()
        text = str(payload.get("facts", {}).get("message", ""))
        if not text or len(text) > 250:
            raise ValueError("INVALID_RECEIPT")
        return web.json_response({"text": text})

    async def receive(self, event):
        if event.get_platform_id() != self.platform_id:
            return
        event.stop_event()  # this platform is owned exclusively by the Core
        if event.get_group_id() or str(event.get_sender_id()) != self.owner_id:
            return
        raw = event.message_obj.raw_message
        if not isinstance(raw, dict):
            raw = dict(raw)
        if str(raw.get("self_id")) != self.bot_id or not self.owner_id:
            return
        if raw.get("message_type") != "private" or raw.get("post_type") != "message":
            return
        stamp = raw.get("time")
        if not isinstance(stamp, (int, float)) or abs(time.time() - stamp) > 30 * 86400:
            return
        segments = raw.get("message", [])
        if not isinstance(segments, list):
            return
        text = "".join(str(s.get("data", {}).get("text", "")) for s in segments if s.get("type") == "text")
        if not text.strip():
            return
        reply = next((str(s["data"]["id"]) for s in segments if s.get("type") == "reply" and s.get("data", {}).get("id") is not None), None)
        message_id = raw.get("message_id")
        if message_id is None:
            return
        payload = {"bot_id": self.bot_id, "user_id": self.owner_id, "message_id": str(message_id), "text": text, "occurred_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(stamp)), "reply_to": reply}
        for delay in (0, 1, 3):
            if delay:
                await asyncio.sleep(delay)
            try:
                await self.core_post("/internal/channel-input", payload)
                self.last_event = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                return
            except Exception:
                continue
        # Fail visibly to the caller without logging private content. No LLM fallback.
        raise ValueError("CORE_INPUT_UNAVAILABLE")

    async def send(self, request):
        message = await request.json()
        if str(message.get("recipient", "").split(":")[-1]) != self.owner_id or not self.owner_id:
            return web.json_response({"status": "failed", "reason": "RECIPIENT_FORBIDDEN"})
        body, key = message.get("body"), message.get("id")
        if not isinstance(body, str) or not body or len(body.encode("utf-16-le")) // 2 > 2000 or not isinstance(key, str):
            return web.json_response({"status": "failed", "reason": "INVALID_MESSAGE"})
        if key in self.sends:
            return web.json_response(self.sends[key])
        client = self.client()
        if not client:
            return web.json_response({"status": "failed", "reason": "CHANNEL_DISCONNECTED"})
        self.sends[key] = {"status": "unknown", "reason": "SEND_IN_PROGRESS"}
        try:
            async with asyncio.timeout(12):
                result = await client.call_action("send_private_msg", self_id=int(self.bot_id), user_id=int(self.owner_id), message=[{"type": "text", "data": {"text": body}}])
            external = result.get("message_id")
            value = {"status": "sent", "externalId": str(external)} if external is not None else {"status": "unknown", "reason": "CHANNEL_UNCONFIRMED"}
        except Exception:
            value = {"status": "unknown", "reason": "CHANNEL_UNCONFIRMED"}
        self.sends[key] = value
        if len(self.sends) > 512:
            del self.sends[next(iter(self.sends))]
        return web.json_response(value)

    async def close(self):
        if self.runner:
            await self.runner.cleanup()
        if self.session:
            await self.session.close()
