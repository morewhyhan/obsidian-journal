"""Create the minimal AstrBot runtime config from deployment-only secrets.

The file is deliberately generated at container start. It is never committed,
never mounted from the journal vault, and contains no journal content.
"""
import copy
import json
import os
from pathlib import Path

from astrbot.core.config.default import DEFAULT_CONFIG


def main() -> None:
    data = Path("/AstrBot/data")
    data.mkdir(parents=True, exist_ok=True)
    config_path = data / "cmd_config.json"
    if config_path.exists():
        try:
            existing = json.loads(config_path.read_text(encoding="utf-8-sig"))
            platforms = existing.get("platform", [])
            providers = existing.get("provider", [])
            if any(item.get("id") == "secretary-qq" for item in platforms) and any(
                item.get("id") == "secretary-deepseek" for item in providers
            ):
                return
        except (OSError, json.JSONDecodeError, TypeError):
            pass
    token = os.environ["SECRETARY_BRIDGE_TOKEN"]
    bot_id = os.environ["SECRETARY_QQ_BOT_ID"]
    provider = {
        "id": "secretary-deepseek",
        "provider": "openai",
        "type": "openai_chat_completion",
        "provider_type": "chat_completion",
        "enable": True,
        "key": [token],
        "api_base": "http://core:3180/internal/model/v1",
        "model": os.environ.get("LLM_MODEL", "deepseek-flash"),
        "timeout": 120,
        "proxy": "",
        "custom_headers": {},
    }
    config = copy.deepcopy(DEFAULT_CONFIG)
    config["provider"] = [provider]
    config["provider_settings"].update({
        "enable": False,
        "default_provider_id": provider["id"],
        "provider_pool": [provider["id"]],
        "web_search": False,
        "streaming_response": False,
        "show_tool_use_status": False,
        "max_agent_step": 32,
        "tool_call_timeout": 30,
        "proactive_capability": {"add_cron_tools": False},
    })
    config["platform_settings"].update({
        "enable_id_white_list": False,
        "empty_mention_waiting": False,
        "friend_message_needs_wake_prefix": False,
        "ignore_bot_self_message": True,
    })
    config["platform"] = [{
        "id": "secretary-qq",
        "type": "aiocqhttp",
        "enable": True,
        "ws_reverse_host": "0.0.0.0",
        "ws_reverse_port": 6199,
        "ws_reverse_token": os.environ["NAPCAT_WS_TOKEN"],
    }]
    config["dashboard"].update({
        "enable": False,
        "host": "127.0.0.1",
    })
    config["admins_id"] = [bot_id]
    config["plugin_set"] = ["*"]
    config["log_level"] = "WARNING"
    config["trace_enable"] = False
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
