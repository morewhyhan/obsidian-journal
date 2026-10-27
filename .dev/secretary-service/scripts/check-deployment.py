"""Read-only checks of the running QQ MVP; never print environment values."""
import argparse
import json
import subprocess
import sys
import os
import platform


def inspect_containers(project):
    names = [f"{project}-{name}-1" for name in ("core", "astrbot", "napcat")]
    result = subprocess.run(
        ["docker", "inspect", *names], capture_output=True, text=True, check=True
    )
    return json.loads(result.stdout.lstrip("\ufeff"))


def inspect_provider(project):
    result = subprocess.run(
        ["docker", "exec", f"{project}-astrbot-1", "cat", "/AstrBot/data/cmd_config.json"],
        capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout.lstrip("\ufeff"))


def host_checks(items):
    """Actual host evidence, independent of the container's attestation flag."""
    vault = next((m['Source'] for m in items[0].get('Mounts', []) if m['Destination']=='/vault'), None)
    def query(args):
        result=subprocess.run(args,capture_output=True,text=True,timeout=5)
        return result.stdout.strip() if result.returncode==0 else None
    synchronized=query(['timedatectl','show','--property=NTPSynchronized','--value'])=='yes'
    filesystem=query(['findmnt','-n','-o','FSTYPE','--target',vault]) if vault else None
    return {'linux_host':platform.system()=='Linux','host_ntp_synchronized':synchronized,
            'vault_local_filesystem':filesystem in {'ext4','xfs','btrfs','zfs'},
            'vault_is_real_directory':bool(vault and os.path.isdir(vault) and not os.path.islink(vault))}


def check(items, config):
    core, agent, qq = items
    core_env = dict(value.split("=", 1) for value in core["Config"]["Env"])
    agent_env = dict(value.split("=", 1) for value in agent["Config"]["Env"])
    bridge = agent_env.get("SECRETARY_BRIDGE_TOKEN")
    providers = [p for p in config.get("provider", []) if p.get("enable", True)]
    sources = config.get("provider_sources", [])
    sources_by_id = {source.get("id"): source for source in sources}

    def proxy_connection(settings):
        return (
            settings.get("api_base", "").rstrip("/") == "http://core:3180/internal/model/v1"
            and settings.get("key") == [bridge]
        )

    # AstrBot migrates inline provider settings into provider_sources on start.
    # Validate the actual connection in either format, including unused sources.
    provider_proxy = len(providers) == 1 and all(
        p.get("id") == "secretary-deepseek"
        and proxy_connection(sources_by_id.get(p["provider_source_id"], {}) if "provider_source_id" in p else p)
        for p in providers
    ) and all(proxy_connection(source) for source in sources)
    allowed = {
        "SECRETARY_CORE_URL", "SECRETARY_BRIDGE_TOKEN", "SECRETARY_QQ_BOT_ID",
        "QQ_BOT_ID", "SECRETARY_RECIPIENT", "LLM_MODEL", "NAPCAT_WS_TOKEN",
    }
    names = {value.split("=", 1)[0] for value in agent["Config"]["Env"]}
    unexpected = sorted(
        name for name in names
        if name not in allowed and (
            name.startswith(("SECRETARY_", "LLM_", "NAPCAT_"))
            or name in {"ASTRBOT_DASHBOARD_INITIAL_PASSWORD", "GITHUB_TOKEN", "GH_TOKEN"}
        )
    )
    agent_mounts = agent.get("Mounts", [])
    plugin = "/AstrBot/data/plugins/astrbot_plugin_secretary"
    expected_mounts = {"/AstrBot/data", plugin, "/AstrBot/secretary-bootstrap.py"}
    checks = {
        "services_running": all(item["State"]["Running"] for item in items),
        "core_time_attested":core_env.get('SECRETARY_TIME_SYNCHRONIZED')=='1',
        "core_finite_startup_retry":core['HostConfig'].get('RestartPolicy',{}).get('Name')=='on-failure'
            and 0<core['HostConfig']['RestartPolicy'].get('MaximumRetryCount',0)<=3,
        "agent_environment_whitelist": not unexpected,
        "bridge_token_matches_core": bool(bridge) and bridge == core_env.get("SECRETARY_BRIDGE_TOKEN"),
        "agent_provider_uses_core_proxy": provider_proxy,
        "agent_mount_whitelist": all(m["Destination"] in expected_mounts for m in agent_mounts),
        "agent_plugin_readonly": any(m["Destination"] == plugin and not m["RW"] for m in agent_mounts),
        "core_vault_mounted": any(m["Destination"] == "/vault" for m in core.get("Mounts", [])),
        "core_nonroot": core["Config"]["User"] not in ("", "0", "0:0", "root"),
        "core_agent_readonly": all(item["HostConfig"]["ReadonlyRootfs"] for item in (core, agent)),
        "no_privileged_containers": all(not item["HostConfig"].get("Privileged", False) for item in items),
        "no_docker_socket": all(
            not m["Source"].endswith("docker.sock")
            for item in items for m in item.get("Mounts", [])
        ),
        "agent_ports_private": not agent["HostConfig"].get("PortBindings"),
        "napcat_webui_loopback": all(
            binding.get("HostIp") in ("127.0.0.1", "::1")
            for bindings in (qq["HostConfig"].get("PortBindings") or {}).values()
            for binding in (bindings or [])
        ),
    }
    return {"passed": all(checks.values()), "checks": checks,
            "unexpected_agent_environment_names": unexpected}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default="deploy")
    args = parser.parse_args()
    try:
        items=inspect_containers(args.project)
        report = check(items, inspect_provider(args.project))
        report['host_checks']=host_checks(items)
        report['passed']=report['passed'] and all(report['host_checks'].values())
        report['images']=[{'service':name,'image_id':item.get('Image'),'configured_image':item['Config'].get('Image')} for name,item in zip(('core','astrbot','napcat'),items)]
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        # Docker errors can include deployment values. Do not echo stderr or a traceback.
        print(json.dumps({"passed": False, "error": "DEPLOYMENT_INSPECTION_FAILED"}))
        return 1
    print(json.dumps(report))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
