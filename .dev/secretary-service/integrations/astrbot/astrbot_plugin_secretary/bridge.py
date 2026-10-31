"""Request-scoped tools and authenticated transport; no vault filesystem access."""

import asyncio
import hmac
import json
import hashlib
import re
import time
import uuid
from contextlib import suppress
from datetime import datetime
from pathlib import Path

import aiohttp
import jsonschema
from aiohttp import web
try:
    from .model_contract import model_view
except ImportError:
    # Standalone transport tests load this module directly.
    import importlib.util
    _spec=importlib.util.spec_from_file_location('secretary_model_contract',Path(__file__).with_name('model_contract.py'))
    _module=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(_module)
    model_view=_module.model_view

class CoreToolError(ValueError):
    def __init__(self, data):
        self.data = {k: data[k] for k in ('code', 'message', 'details', 'stage', 'effect', 'retry_policy', 'scope') if k in data}
        super().__init__(data.get('code', 'CORE_REJECTED'))


class Turn:
    def __init__(self, bridge, payload):
        self.bridge = bridge
        self.payload = payload
        self.captured = None
        self.used = 0
        self.limit = min(24, max(2, payload.get("limits", {}).get("max_tools", 16)))
        self.versions = {}
        self.plan_ids = set()
        self.has_mutation = False
        self.memo = {}
        self.native = payload.get('execution_mode') == 'tools-v2'
        self.observe_versions(payload.get("context", {}))

    def observe_versions(self, value):
        if isinstance(value, list):
            for item in value: self.observe_versions(item)
        elif isinstance(value, dict):
            if isinstance(value.get('id'), str) and 'target_ref' in value and 'window_start' in value:
                self.plan_ids.add(value['id'])
            if isinstance(value.get('id'), str) and isinstance(value.get('version'), int):
                self.versions[value['id']] = max(self.versions.get(value['id'], 0), value['version'])
            for key in ('items','plans','proposals','assistant','objects','tasks','habits','automations','user_rules','followups','updated_refs'):
                if key in value: self.observe_versions(value[key])

    # Tools that cannot change state: repeating one with identical arguments
    # always yields the same answer, so a live loop should read it, not pay again.
    READ_ONLY_SECRETARY = {
        "state", "day", "status", "planning", "planning_context", "followups",
        "board", "capabilities", "rules", "automations", "preferences",
        "periods", "history", "history_content", "trash",
    }
    READ_ONLY_WORKSPACE = {"list", "read", "search", "tree", "stat", "outline"}

    def _memo_key(self, name, args):
        if name == "get_context":
            return True, "get_context:" + json.dumps(args, sort_keys=True, ensure_ascii=False)
        if name == "secretary" and args.get("operation") in self.READ_ONLY_SECRETARY:
            return True, "secretary:" + json.dumps(args, sort_keys=True, ensure_ascii=False)
        if name == "workspace" and args.get("operation") in self.READ_ONLY_WORKSPACE:
            return True, "workspace:" + json.dumps(args, sort_keys=True, ensure_ascii=False)
        return False, ""

    async def call(self, name, args):
        memo, key = self._memo_key(name, args)
        if memo and key in self.memo:
            # Break identical read loops. The repeat still costs budget (a loop
            # must stay bounded) but it is not worth another Core round-trip, and
            # the answer tells the model to move on instead of retrying.
            self.used += 1
            if self.used > self.limit:
                raise ValueError("TOOL_LIMIT")
            return json.dumps({
                "repeat": True,
                "notice": "同一调用本回合已经执行过，结果未变化；直接用这个结果继续，不要重复同一调用。",
                "result": json.loads(self.memo[key]),
            }, ensure_ascii=False)
        out = await self._call_impl(name, args)
        if memo:
            self.memo[key] = out
        return out

    async def _call_impl(self, name, args):
        self.used += 1
        if self.used > self.limit:
            raise ValueError("TOOL_LIMIT")
        if self.captured is not None:
            return json.dumps({"error": {"code": "PROPOSAL_ALREADY_SUBMITTED", "message": "已提交最终提案，不再执行工具。"}}, ensure_ascii=False)
        definition = next(t for t in self.bridge.tools if t["name"] == name)
        try:
            validator = getattr(self.bridge, 'validators', {}).get(name)
            if validator is not None:
                validator.validate(args)
            else:
                jsonschema.validate(args, definition["parameters"])
        except jsonschema.ValidationError as error:
            # Return only the contract path, never arguments or private content.
            path = '.'.join(str(p) for p in error.absolute_path)[:240]
            expected = error.validator_value if error.validator in ('type', 'enum', 'required', 'minimum', 'maximum') else None
            return json.dumps({"error": {"code": "TOOL_VALIDATION_FAILED", "path": path, "constraint": error.validator,
                "expected": expected, "message": "参数不符合契约，未执行；按path和expected修正后在本回合重新提交。普通recurring不支持按小时参数；每小时回顾用hourly_checkin。contact.style是字符串，只有working.*使用原则对象。"}}, ensure_ascii=False)
        if name == "submit_proposal":
            if self.native:
                return json.dumps({'error':{'code':'USE_BUSINESS_TOOLS','message':'明确交代用secretary.apply_changes，已有建议的决定用resolve_proposals；确实未定才用save_proposals。完成后自然回复。'}}, ensure_ascii=False)
            if args['reply_intent']=='receipt' and not args['action_groups'] and not self.has_mutation:
                return json.dumps({'error':{'code':'EMPTY_EXECUTION_RECEIPT','message':'没有业务动作或成功的文件变更，不能报成已办理。普通查询使用discussion；执行请求须提交实际动作，做不到时如实说明。'}},ensure_ascii=False)
            for group in args['action_groups']:
                for action in group['actions']:
                    if action.get('type') == 'reschedule' and (action.get('plan_id') is not None or action.get('target_id') not in self.plan_ids):
                        return json.dumps({'error':{'code':'PLAN_TARGET_REQUIRED','message':'reschedule.target_id必须是已读取的安排plan.id，expected_version是该安排版本，不能用task.id。plan_id只用于report_execution，不用于改期。先从secretary.planning读取实际安排，再修正本轮提案；未执行。'}},ensure_ascii=False)
                    if action.get('type') in {'update_task','configure_task'} and any(k in action for k in ('next_action','remaining_minutes','blocker')):
                        return json.dumps({'error':{'code':'TASK_PLANNING_NESTING','message':'任务下一步、剩余时长和阻碍须放planning对象中，不能使用顶层next_action/remaining_minutes/blocker；请修正后本轮重新提交，未执行。'}},ensure_ascii=False)
                    if action.get('type') == 'create_task' and action.get('due_at') and action.get('initial_plan'):
                        try:
                            due = datetime.fromisoformat(action['due_at'].replace('Z', '+00:00'))
                            end = datetime.fromisoformat(action['initial_plan']['window_end'].replace('Z', '+00:00'))
                            if due.tzinfo is None or end.tzinfo is None: raise ValueError('MISSING_OFFSET')
                        except (ValueError, TypeError):
                            return json.dumps({'error':{'code':'INVALID_DATETIME','message':'时间必须为带时区偏移或Z的完整ISO时间；核对后在本轮重新提交，未执行。'}},ensure_ascii=False)
                        if end > due:
                            return json.dumps({'error':{'code':'DEADLINE_WINDOW_CONFLICT','message':'新任务的执行窗口超过同时设置的硬截止，未执行。核对用户原话和时区：当地时刻加原偏移，或等价UTC加Z；不要把UTC数字再标成本地偏移。不要自行延长用户截止；修正后本轮重新提交，确实不可兼容则说明取舍。'}},ensure_ascii=False)
                    target=action.get('target_id')
                    if target and 'expected_version' in action and target in self.versions and action['expected_version'] != self.versions[target]:
                        return json.dumps({'error':{'code':'VERSION_SNAPSHOT_REQUIRED','target_id':target,
                            'expected_version':self.versions[target], 'message':'同一批中每个动作都使用读取时的原版本，不猜执行后的版本；Core在同一个事务里核验原快照。请修正后本轮重新提交。'}},ensure_ascii=False)
            if args.get("clarification") and args["reply_intent"] != "clarification":
                return json.dumps({"error": {"code": "CLARIFICATION_INTENT", "message": "有必要问题时reply_intent必须为clarification；请修正后提交。"}}, ensure_ascii=False)
            if not args["action_groups"] and not any(
                str(args.get(k) or "").strip() for k in ("discussion", "summary", "clarification")
            ):
                return json.dumps({"error": {"code": "EMPTY_ANSWER", "message": "最终回答为空，请如实说明结果或限制。"}}, ensure_ascii=False)
            self.captured = args
            return "提案已接收，尚未执行；由Core实际结果生成回执。"
        if name == "get_context":
            context = self.payload["context"]
            ids = args["ids"]
            return json.dumps({
                "items": [x for x in context.get("items", []) if not ids or x["id"] in ids],
                "now": context.get("now"), "business_date": context.get("business_date"),
                "now_local": context.get("now_local"), "timezone": context.get("timezone"),
                "tomorrow_date": context.get("tomorrow_date"),
            }, ensure_ascii=False)
        endpoint = {"secretary": "application", "workspace": "workspace"}[name]
        try:
            result = await self.bridge.core_post("/internal/" + endpoint, {
                **args, "input_id": self.payload["input"]["id"], "call_id": uuid.uuid4().hex,
            })
        except ValueError as error:
            if isinstance(error, CoreToolError):
                return json.dumps({'error':error.data}, ensure_ascii=False)
            # A rejected operation is useful feedback, not a reason to kill the agent loop.
            code = str(error) if re.fullmatch(r"[A-Z][A-Z_]{1,79}", str(error)) else "CORE_REJECTED"
            message = ("规划作业不能使用workspace或私人叙述；只用Core给出的目标片段和只读业务查询。"
                if code == "PLANNING_SCOPE" else "任务和习惯须通过业务动作保存，由Core投影到日记；不能先手写任务栏制造已安排的假象。请提交正确的任务、安排动作。"
                if code == "BUSINESS_TOOL_REQUIRED" else "Core拒绝了这次操作，未执行；修正参数或如实报告限制，不声称成功。")
            return json.dumps({"error": {"code": code, "message": message}}, ensure_ascii=False)
        self.observe_versions(result)
        if self.native and name == 'secretary' and any(x.get('status') == 'applied' for x in result.get('results', [])):
            self.has_mutation = True
        if (name=='workspace' and args.get('operation') in {'write','edit','rename','delete'}) or (name=='secretary' and args.get('operation') in {'create_period','restore_note','restore_version'}):
            self.has_mutation = True
        return json.dumps(model_view(result), ensure_ascii=False,separators=(',',':'))


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
        self.tools_hash = 'sha256:' + hashlib.sha256(json.dumps(self.tools, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        self.validators = {}
        for tool in self.tools:
            cls = jsonschema.validators.validator_for(tool['parameters'])
            cls.check_schema(tool['parameters'])
            self.validators[tool['name']] = cls(tool['parameters'])
        self.lock = asyncio.Lock()
        self.session = None
        self.runner = None
        self.last_event = None
        self.last_failure = None
        self.sends = {}  # bounded duplicate protection; Core owns durable claims

    def tools_for(self, native: bool, self_test: bool = False):
        """Native turns answer in prose, so the legacy submit_proposal schema is
        dead weight: it doubles the prompt and every token is latency and cost.
        The protocol probe never calls a tool, and shipping the whole catalog to
        it made the first call after every restart time out while the provider
        warmed up."""
        # The legacy self-test returns its answer through submit_proposal, so it
        # keeps the full catalog; only native turns drop the duplicate schema.
        if self_test:
            return self.tools
        if not native:
            return self.tools
        return [tool for tool in self.tools if tool["name"] != "submit_proposal"]

    async def core_post(self, route, payload):
        async with self.session.post(
            self.core_url + route, json=payload, allow_redirects=False,
            headers={"Authorization": "Bearer " + self.token},
        ) as response:
            value = await response.json()
            if response.status >= 300:
                raise CoreToolError(value.get("error", {"code":"CORE_REJECTED"}))
            return value

    async def start(self, host="0.0.0.0", port=3181):
        self.session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30))

        @web.middleware
        async def auth(request, handler):
            if not hmac.compare_digest(request.headers.get("Authorization", ""), "Bearer " + self.token):
                return web.json_response({"error": {"code": "FORBIDDEN"}}, status=403)
            try:
                return await handler(request)
            except Exception as error:
                # Keep diagnostic categories, never raw SDK messages, prompts, keys or URLs.
                code = "BRIDGE_TIMEOUT" if isinstance(error, (asyncio.TimeoutError, TimeoutError)) else "BRIDGE_UNAVAILABLE"
                if isinstance(error, ValueError) and str(error) in {"AGENT_INVALID", "TOOL_LIMIT", "INVALID_RECEIPT","MODEL_INPUT_LIMIT","MODEL_PROVIDER_FAILED","MODEL_INVALID_FINAL"}:
                    code = str(error)
                self.last_failure = {"code": code, "reason": type(error).__name__, "operation": request.path,
                    "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
                return web.json_response({"error": self.last_failure}, status=503)

        app = web.Application(middlewares=[auth], client_max_size=150000)
        app.router.add_get("/healthz", self.health)
        app.router.add_post("/interpret", self.interpret)
        app.router.add_post("/compose", self.compose)
        app.router.add_post("/classify", self.classify)
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
        return web.json_response({"ok": True, "agent": "astrbot", "protocol":"tools-v2", "tools_hash":self.tools_hash, "qq": await self.channel_health(), "last_failure": self.last_failure})

    async def interpret(self, request):
        payload = await request.json()
        timeout = min(120, max(10, payload.get("limits", {}).get("timeout_ms", 120000) / 1000))
        async with asyncio.timeout(timeout):
            async with self.lock:
                source = payload['input']
                kind = 'self_test' if source['id'] == 'model-self-test' else 'background' if source.get('channel') == 'coordinator' else 'front'
                job = await self.core_post('/internal/model/jobs/start', {'input_id':source['id'], 'kind':kind, 'tools_hash':self.tools_hash})
                try:
                    turn = Turn(self, payload)
                    await self.context.run_secretary(turn)
                    if turn.captured is None:
                        raise ValueError("AGENT_INVALID")
                    return web.json_response(turn.captured)
                finally:
                    with suppress(Exception):
                        await self.core_post('/internal/model/jobs/end', {'job_id':job['id']})

    async def compose(self, request):
        payload = await request.json()
        timeout = min(30, max(5, payload.get('limits', {}).get('timeout_ms', 10000) / 1000))
        async with asyncio.timeout(timeout):
            async with self.lock:
                job = await self.core_post('/internal/model/jobs/start', {'input_id':'compose-'+uuid.uuid4().hex, 'kind':'compose', 'tools_hash':self.tools_hash})
                try:
                    text = await self.context.compose_secretary(payload)
                finally:
                    with suppress(Exception):
                        await self.core_post('/internal/model/jobs/end', {'job_id':job['id']})
        if not text or len(text) > 1800:
            raise ValueError("INVALID_RECEIPT")
        return web.json_response({"text": text})

    async def classify(self, request):
        payload = await request.json()
        timeout = min(60, max(10, payload.get('limits', {}).get('timeout_ms', 30000) / 1000))
        try:
            async with asyncio.timeout(timeout):
                async with self.lock:
                    # Understanding spends model budget like any other call; the
                    # Core job ledger must record it.
                    job = await self.core_post('/internal/model/jobs/start', {
                        'input_id': 'classify-' + uuid.uuid4().hex, 'kind': 'classify', 'tools_hash': self.tools_hash})
                    try:
                        result = await self.context.classify_secretary(payload)
                    finally:
                        with suppress(Exception):
                            await self.core_post('/internal/model/jobs/end', {'job_id': job['id']})
        except (ValueError, TimeoutError) as error:
            return web.json_response(
                {'error': {'code': 'AGENT_INVALID', 'message': str(error)[:200]}}, status=502)
        return web.json_response(result)

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
