const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
class Plugin{addCommand(){}addRibbonIcon(){}registerEvent(){}register(){}registerInterval(){}}
class Pages extends Array{
  where(fn){return Pages.from(this.filter(fn));}
  sort(fn,order){return Pages.from([...this].sort((a,b)=>String(fn(a)).localeCompare(String(fn(b)))*(order==='desc'?-1:1)));}
}
async function main(){
  const script=read('.obsidian/plugins/light-okr/main.js');
  assert.equal(script,require('./构建联动插件.cjs').bundle());
  const layout=[],timers=[],external=[];
  const runtime={module:{exports:{}},require:id=>{
    external.push(id);assert.equal(id,'obsidian','入口不可再向宿主请求 ./core 等本地模块');
    return {Plugin,Notice:class{},Modal:class{}};
  },console,setTimeout:fn=>{const timer={fn};timers.push(timer);return timer;},clearTimeout:()=>{},setInterval:()=>0};
  vm.runInNewContext(script,runtime);
  let finishRead,touches=0;
  const app={vault:{adapter:{read:()=>new Promise(resolve=>finishRead=resolve)},on:()=>{}},workspace:{onLayoutReady:fn=>layout.push(fn)},plugins:{plugins:{dataview:{index:{touch:()=>touches++}}}}};
  const plugin=new runtime.module.exports();plugin.app=app;
  const loading=plugin.onload();
  assert(plugin.dashboard&&plugin.engine,'异步读取旧笔记索引时，主页与日记接口应已就绪');
  assert.equal(app.plugins.plugins['light-okr'],undefined);
  finishRead('{"routes":{},"files":[]}');await loading;
  app.plugins.plugins['light-okr']=plugin;
  layout.forEach(fn=>fn());assert.equal(touches,0);
  timers.forEach(timer=>timer.fn());assert.equal(touches,1,'插件加载完成后应刷新已经打开的 Dataview 页面');
  assert.deepEqual(external,['obsidian']);

  const names=['MOC.md','01. Daily/README.md','02. Decisions/README.md','03. Manual/README.md'];
  const blocks=names.flatMap(name=>[...read(name).matchAll(/(?:`{3}|~{3})dataviewjs\s*\n([\s\S]*?)\n(?:`{3}|~{3})/g)].map(m=>({name,code:m[1]})));
  assert.equal(blocks.length,4);
  for(const state of [undefined,{}]){
    const output={paragraphs:[],lists:[]},pages=Pages.from([{file:{name:'2026-10-17',link:'原有日记'}},{file:{name:'README',link:'不应列出'}}]);
    const dv={paragraph:t=>output.paragraphs.push(t),list:rows=>output.lists.push([...rows]),pages:()=>pages,fileLink:(p,e,label)=>label||p};
    const app={plugins:{plugins:{'light-okr':state}}};
    for(const block of blocks)await vm.runInNewContext('(async()=>{'+block.code+'})()',{app,dv});
    assert(output.paragraphs.some(t=>t.includes('轻量 OKR 联动')));
    assert(output.lists.some(rows=>rows.includes('Daily · 日记与计划')));
    assert(output.lists.some(rows=>rows.includes('原有日记')));
    assert(!output.lists.some(rows=>rows.includes('不应列出')));
  }
  const calls=[],ready={dashboard:{start:async()=>calls.push('start'),navigation:()=>calls.push('navigation'),recent:()=>calls.push('recent')},engine:{home:async()=>calls.push('daily')}};
  for(const block of blocks)await vm.runInNewContext('(async()=>{'+block.code+'})()',{app:{plugins:{plugins:{'light-okr':ready}}},dv:{}});
  assert.deepEqual(calls,['start','navigation','recent','daily']);
  console.log('PASS: self-contained plugin with Obsidian-only host require; source/build consistency; interfaces available before asynchronous initialization; deferred Dataview refresh; all 4 page blocks handle missing/partial plugins without errors; fallback links and historical diaries; ready-plugin rendering.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
