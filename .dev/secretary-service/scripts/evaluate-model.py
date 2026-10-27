"""Run the real production images with synthetic data in a disposable network.

Run on the Docker host. Model credentials are inherited in memory from the
existing Core container; no personal volume, QQ connection, published port or
credential file is shared. Evidence contains only the synthetic conversation.
"""
import argparse
import io
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tarfile
import time

parser = argparse.ArgumentParser()
parser.add_argument('--core-container', default='deploy-core-1')
parser.add_argument('--astrbot-container', default='deploy-astrbot-1')
parser.add_argument('--suite', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--cases', default='')
parser.add_argument('--core-image', default='')
parser.add_argument('--runtime-root', type=Path)
parser.add_argument('--reuse-runtime', action='store_true', help='SDK worker and Core in separate /tmp roots inside existing runtimes; no service restart')
parser.add_argument('--repeat', type=int, default=1, help='1–5 fresh SDK evaluation runs; retain every outcome')
args = parser.parse_args()
if not 1<=args.repeat<=5 or (args.repeat!=1 and not args.reuse_runtime):
    parser.error('--repeat requires SDK mode and a value from 1 to 5')
suite = args.suite.resolve()
output = args.output.resolve()
if not (suite / 'evaluate-model.mjs').is_file():
    raise SystemExit('Evaluation suite not found')
output.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(output, 0o700)

def run(command, **kwargs):
    return subprocess.run(command, check=True, text=True, **kwargs)

source = json.loads(subprocess.check_output(['docker','inspect',args.core_container], text=True))[0]
existing = dict(x.split('=',1) for x in source['Config']['Env'])
env = os.environ.copy()
for key in ('LLM_BASE_URL','LLM_API_KEY','LLM_MODEL'):
    if not existing.get(key): raise SystemExit('Model configuration missing')
    env[key] = existing[key]
env['SECRETARY_BRIDGE_TOKEN'] = secrets.token_hex(32)
tag = 'secretary-eval-' + secrets.token_hex(4)
core, agent = tag + '-core', tag + '-agent'

def run_sdk():
    if not args.runtime_root: raise SystemExit('--runtime-root required for SDK evaluation')
    candidate=args.runtime_root.resolve()
    runtime='/tmp/secretary-model-runtime-'+secrets.token_hex(6)
    ai=json.loads(subprocess.check_output(['docker','inspect',args.astrbot_container],text=True))[0]
    common=set(source['NetworkSettings']['Networks']) & set(ai['NetworkSettings']['Networks'])
    private=next((n for n in common if n.endswith('_private')),None)
    if not private: raise SystemExit('Private Core/AstrBot network required')
    env['SECRETARY_CORE_URL']='http://'+source['NetworkSettings']['Networks'][private]['IPAddress']+':3190'
    env['SECRETARY_ASTRBOT_URL']='http://'+ai['NetworkSettings']['Networks'][private]['IPAddress']+':3191'
    env.update(ASTRBOT_ROOT=runtime,SECRETARY_EVAL_AGENT_PORT='3191',SECRETARY_EVAL_CORE_PORT='3190',
        SECRETARY_EVAL_ISOLATED='1',SECRETARY_EVAL_PROJECT=runtime+'/runtime',
        SECRETARY_EVAL_OUTPUT=runtime+'/evidence',SECRETARY_EVAL_CASES=args.cases)
    def command(container,keys,*tail):
        out=['docker','exec','--user','0']
        for key in keys: out.extend(['-e',key])
        return out+[container,*tail]
    def put(container, source_path, destination):
        run(['docker','exec','--user','0',container,'mkdir','-p',destination],stdout=subprocess.DEVNULL)
        buffer=io.BytesIO()
        with tarfile.open(fileobj=buffer,mode='w:gz') as archive:
            archive.add(source_path,arcname='.' if source_path.is_dir() else source_path.name)
        subprocess.run(['docker','exec','-i','--user','0',container,'tar','--no-same-owner','-xzf','-','-C',destination],input=buffer.getvalue(),check=True,stdout=subprocess.DEVNULL)
    process=None
    log_file=(output/'sdk-worker.log').open('w')
    try:
        for container in (args.core_container,args.astrbot_container):
            run(['docker','exec','--user','0',container,'mkdir','-p',runtime],stdout=subprocess.DEVNULL)
        put(args.core_container,candidate,runtime+'/runtime')
        put(args.core_container,suite,runtime+'/suite')
        # Candidate-only pure JS additions live beside links to the installed SDK dependencies.
        # Never install into or modify /app/node_modules of the production service.
        link="const fs=require('fs'),p=require('path'),to=process.argv[1];fs.mkdirSync(to,{recursive:true});for(const name of fs.readdirSync('/app/node_modules')){const target=p.join(to,name);if(!fs.existsSync(target))fs.symlinkSync(p.join('/app/node_modules',name),target,'dir');}"
        run(['docker','exec','--user','0',args.core_container,'node','-e',link,runtime+'/runtime/node_modules'])
        put(args.astrbot_container,suite/'astrbot_plugin_secretary',runtime+'/astrbot_plugin_secretary')
        put(args.astrbot_container,suite/'evaluate-astrbot.py',runtime)
        for test in ('test_agent_loop.py','test_bridge.py'):
            if (suite/test).is_file(): put(args.astrbot_container,suite/test,runtime)
        process=subprocess.Popen(command(args.astrbot_container,
            ['ASTRBOT_ROOT','SECRETARY_BRIDGE_TOKEN','SECRETARY_CORE_URL','LLM_MODEL','SECRETARY_EVAL_AGENT_PORT'],
            'python','-u',runtime+'/evaluate-astrbot.py'),env=env,text=True,stdout=log_file,stderr=subprocess.STDOUT)
        for _ in range(180):
            check=subprocess.run(command(args.core_container,['SECRETARY_BRIDGE_TOKEN','SECRETARY_ASTRBOT_URL'],
                'node','-e',"fetch(process.env.SECRETARY_ASTRBOT_URL+'/healthz',{headers:{Authorization:'Bearer '+process.env.SECRETARY_BRIDGE_TOKEN},signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"),
                env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            if check.returncode==0: break
            if process.poll() is not None: raise RuntimeError('SDK_WORKER_START_FAILED')
            time.sleep(1)
        else: raise RuntimeError('SDK_WORKER_START_TIMEOUT')
        codes=[]
        for iteration in range(args.repeat):
            env['SECRETARY_EVAL_OUTPUT']=runtime+'/evidence-'+str(iteration)
            result=subprocess.run(command(args.core_container,
                ['SECRETARY_BRIDGE_TOKEN','LLM_BASE_URL','LLM_API_KEY','LLM_MODEL','SECRETARY_ASTRBOT_URL',
                 'SECRETARY_EVAL_ISOLATED','SECRETARY_EVAL_PROJECT','SECRETARY_EVAL_OUTPUT','SECRETARY_EVAL_CASES','SECRETARY_EVAL_CORE_PORT'],
                'node',runtime+'/suite/evaluate-model.mjs'),env=env,text=True)
            evidence=subprocess.check_output(['docker','exec',args.core_container,'cat',env['SECRETARY_EVAL_OUTPUT']+'/results.json'])
            name='results.json' if args.repeat==1 else 'results-'+str(iteration+1)+'.json'
            (output/name).write_bytes(evidence)
            codes.append(result.returncode)
        return 1 if any(codes) else 0
    finally:
        stop="import os,pathlib,signal; r=pathlib.Path('"+runtime+"'); p=r/'worker.pid'; pid=int(p.read_text()) if p.exists() else 0; cmd=pathlib.Path('/proc/'+str(pid)+'/cmdline'); os.kill(pid,signal.SIGTERM) if pid and cmd.exists() and str(r/'evaluate-astrbot.py').encode() in cmd.read_bytes().split(b'\\0') else None"
        subprocess.run(['docker','exec','--user','0',args.astrbot_container,'python','-c',stop],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        if process:
            try: process.wait(timeout=15)
            except subprocess.TimeoutExpired: process.terminate()
        log_file.close()
        value=(output/'sdk-worker.log').read_text()
        for key in ('SECRETARY_BRIDGE_TOKEN','LLM_API_KEY'): value=value.replace(env[key],'[redacted]')
        (output/'sdk-worker.log').write_text(value);os.chmod(output/'sdk-worker.log',0o600)
        # Exact generated roots only; rm does not traverse the node_modules symlink.
        for container in (args.core_container,args.astrbot_container):
            clean="import pathlib,shutil; r=pathlib.Path('"+runtime+"'); assert r.parent==pathlib.Path('/tmp') and r.name.startswith('secretary-model-runtime-'); shutil.rmtree(r)"
            if container==args.core_container:
                clean_js="const fs=require('fs'),path=require('path');const r='"+runtime+"';if(path.dirname(r)!=='/tmp'||!path.basename(r).startsWith('secretary-model-runtime-'))throw Error('UNSAFE_CLEANUP');fs.rmSync(r,{recursive:true,force:true});"
                subprocess.run(['docker','exec','--user','0',container,'node','-e',clean_js],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            else: subprocess.run(['docker','exec','--user','0',container,'python','-c',clean],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

if args.reuse_runtime:
    raise SystemExit(run_sdk())

bootstrap = '''import copy,json,os
from pathlib import Path
from astrbot.core.config.default import DEFAULT_CONFIG
c=copy.deepcopy(DEFAULT_CONFIG)
c['provider']=[{'id':'secretary-deepseek','provider':'openai','type':'openai_chat_completion','provider_type':'chat_completion','enable':True,'key':[os.environ['SECRETARY_BRIDGE_TOKEN']],'api_base':'http://core:3180/internal/model/v1','model':os.environ['LLM_MODEL'],'timeout':120,'proxy':'','custom_headers':{}}]
c['provider_settings'].update({'enable':False,'default_provider_id':'secretary-deepseek','provider_pool':['secretary-deepseek'],'web_search':False,'streaming_response':False,'show_tool_use_status':False,'max_agent_step':32,'tool_call_timeout':30,'proactive_capability':{'add_cron_tools':False}})
c['platform']=[]
c['dashboard']['enable']=False
c['plugin_set']=['*'];c['log_level']='ERROR';c['trace_enable']=False
Path('/AstrBot/data/cmd_config.json').write_text(json.dumps(c))
'''
(output/'bootstrap.py').write_text(bootstrap)
plugin = suite / 'astrbot_plugin_secretary'
if not (plugin/'main.py').is_file(): raise SystemExit('Actual AstrBot plugin required')
# AstrBot validates dashboard assets even when its dashboard is disabled.
# Copy only the installed public static bundle to avoid a startup download.
dashboard=output/'dashboard'
if not dashboard.exists():
    run(['docker','cp',args.astrbot_container+':/AstrBot/astrbot/dashboard/dist',str(dashboard)],stdout=subprocess.DEVNULL)
runtime_mounts=[]
if args.runtime_root:
    candidate=args.runtime_root.resolve()
    for relative,target in (('dist/server','/app/dist/server'),('resources','/app/resources')):
        if not (candidate/relative).is_dir(): raise SystemExit('Candidate runtime missing')
        runtime_mounts.extend(['--mount',f'type=bind,src={candidate/relative},dst={target},readonly'])
try:
    run(['docker','network','create',tag], stdout=subprocess.DEVNULL)
    run(['docker','run','-d','--name',agent,'--network',tag,'--network-alias','astrbot',
         '--memory','512m','--cpus','0.6','--cap-drop','ALL','--security-opt','no-new-privileges',
         '--tmpfs','/AstrBot/data:size=128m','--mount',f'type=bind,src={plugin},dst=/AstrBot/data/plugins/astrbot_plugin_secretary,readonly',
         '--mount',f'type=bind,src={output / "bootstrap.py"},dst=/eval-bootstrap.py,readonly',
         '--mount',f'type=bind,src={dashboard},dst=/eval-dashboard,readonly',
         '-e','SECRETARY_BRIDGE_TOKEN','-e','LLM_MODEL','-e','SECRETARY_CORE_URL=http://core:3180',
         '--entrypoint','sh','soulter/astrbot:v4.29.1','-c','python /eval-bootstrap.py && python main.py --webui-dir /eval-dashboard'],
        env=env, stdout=subprocess.DEVNULL)
    # The Core runner serves only the isolated Core callbacks and model proxy.
    run(['docker','run','-d','--name',core,'--network',tag,'--network-alias','core',
         '--memory','384m','--cpus','0.6','--cap-drop','ALL','--security-opt','no-new-privileges',
         '--mount',f'type=bind,src={suite},dst=/suite,readonly',
         '--mount',f'type=bind,src={output},dst=/evidence',
         '-e','SECRETARY_BRIDGE_TOKEN','-e','LLM_BASE_URL','-e','LLM_API_KEY','-e','LLM_MODEL',
         '-e','SECRETARY_EVAL_ISOLATED=1','-e','SECRETARY_EVAL_PROJECT=/app',
         '-e','SECRETARY_EVAL_OUTPUT=/evidence','-e','SECRETARY_ASTRBOT_URL=http://astrbot:3181',
         '-e','SECRETARY_EVAL_CASES='+args.cases,
         *runtime_mounts,'--user','0:0','--entrypoint','sh',args.core_image or source['Image'],'-c',
         'node -e "setTimeout(()=>{},1000000)"'], env=env, stdout=subprocess.DEVNULL)
    for _ in range(90):
        check = subprocess.run(['docker','exec',core,'node','-e',
          "fetch('http://astrbot:3181/healthz',{headers:{Authorization:'Bearer '+process.env.SECRETARY_BRIDGE_TOKEN},signal:AbortSignal.timeout(1500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
          stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        if check.returncode == 0: break
        time.sleep(1)
    else: raise RuntimeError('ISOLATED_ASTRBOT_START_FAILED')
    result = subprocess.run(['docker','exec',core,'node','/suite/evaluate-model.mjs'], text=True)
    raise SystemExit(result.returncode)
finally:
    for name, label in ((core,'core'),(agent,'agent')):
        log = subprocess.run(['docker','logs',name],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT).stdout
        for key in ('SECRETARY_BRIDGE_TOKEN','LLM_API_KEY'):
            log = log.replace(env[key],'[redacted]')
        target=output/(label+'.log'); target.write_text(log); os.chmod(target,0o600)
    # Only the two names generated by this invocation are removed; no volumes.
    for name in (core,agent):
        subprocess.run(['docker','rm','-f',name], stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    subprocess.run(['docker','network','rm',tag], stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    (output/'bootstrap.py').unlink(missing_ok=True)
