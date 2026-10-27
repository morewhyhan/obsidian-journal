"""A private SDK worker: actual AstrBot provider, loop and unmodified plugin.

No platform manager, QQ session, dashboard, builtin tools or personal data is
loaded. ASTROOT must be a dedicated temporary directory before any imports.
"""
import asyncio
import os
from pathlib import Path
import signal
import sys
import importlib.util
import unittest
import faulthandler

root = Path(os.environ['ASTRBOT_ROOT']).resolve()
if root.parent != Path('/tmp') or not root.name.startswith('secretary-model-runtime-'):
    raise RuntimeError('ISOLATED_ASTROOT_REQUIRED')
root.mkdir(parents=True, exist_ok=True)
(root/'worker.pid').write_text(str(os.getpid()))
print('EVALUATION_SDK_IMPORTING',flush=True)
# The production image is read-only. Keep SDK bytecode in its temporary
# filesystem so repeated evaluations do not recompile thousands of SDK types.
sys.pycache_prefix='/tmp/secretary-model-sdk-cache'
faulthandler.dump_traceback_later(30, repeat=True)
sys.path.insert(0, str(root))
sys.path.insert(0, '/AstrBot')
from astrbot.api.star import Context
from astrbot.core.provider.sources.openai_source import ProviderOpenAIOfficial
from astrbot_plugin_secretary.main import SecretaryPlugin

for test_name in ('test_bridge.py','test_agent_loop.py'):
    test_file=root/test_name
    if not test_file.exists(): continue
    os.environ['SECRETARY_TEST_PLUGIN_ROOT']=str(root)
    spec=importlib.util.spec_from_file_location('secretary_eval_'+test_file.stem,test_file)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    result=unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromModule(module))
    if not result.wasSuccessful(): raise RuntimeError('AGENT_LOOP_REGRESSION_FAILED')
faulthandler.cancel_dump_traceback_later()


class EvaluationContext(Context):
    def __init__(self, provider):
        class Providers:
            async def get_provider_by_id(self, name):
                return provider if name == 'secretary-deepseek' else None
        class Platforms:
            def get_insts(self):
                return []
        self.provider_manager = Providers()
        self.platform_manager = Platforms()

    def get_config(self, **_kwargs):
        return {'provider_settings': {'computer_use_runtime': 'none'}}


async def main():
    config = {'id':'secretary-deepseek','provider':'openai','type':'openai_chat_completion',
        'provider_type':'chat_completion','key':[os.environ['SECRETARY_BRIDGE_TOKEN']],
        'api_base':os.environ['SECRETARY_CORE_URL']+'/internal/model/v1',
        'model':os.environ.get('LLM_MODEL','deepseek-flash'),'timeout':120,'custom_headers':{}}
    provider=ProviderOpenAIOfficial(config,{})
    os.environ['QQ_BOT_ID']=''
    os.environ['SECRETARY_RECIPIENT']=''
    plugin=SecretaryPlugin(EvaluationContext(provider))
    await plugin.bridge.start(port=int(os.environ.get('SECRETARY_EVAL_AGENT_PORT','3191')))
    stop=asyncio.Event()
    for signum in (signal.SIGTERM,signal.SIGINT):
        asyncio.get_running_loop().add_signal_handler(signum,stop.set)
    print('EVALUATION_SDK_READY',flush=True)
    try:
        await stop.wait()
    finally:
        await plugin.bridge.close()
        await provider.client.close()


asyncio.run(main())
