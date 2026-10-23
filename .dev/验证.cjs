const fs=require('fs'),path=require('path'),assert=require('assert/strict'),vm=require('vm');
const root=path.resolve(__dirname,'..');
const core=require(path.join(root,'.obsidian/plugins/light-okr/core'));
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const config=p=>JSON.parse(read(p).replace(/^\uFEFF/,''));
const notices=[];
class FakePlugin {constructor(){this.disposers=[];} register(fn){this.disposers.push(fn);} }
const sandbox={module:{exports:{}},require:id=>{assert.equal(id,'obsidian','插件运行时不能依赖未打包的本地模块');return {Plugin:FakePlugin,Modal:class{},Notice:class{constructor(s){notices.push(s);}}};},console,setTimeout,clearTimeout,setInterval};
assert.equal(read('.obsidian/plugins/light-okr/main.js'),require('./构建联动插件.cjs').bundle(),'修改源文件后必须重新构建插件');
vm.runInNewContext(read('.obsidian/plugins/light-okr/main.js'),sandbox);
const Adapter=sandbox.module.exports;
class DA extends Array {
  static fromValues(v){return DA.from(v);}
  where(fn){return DA.fromValues(this.filter(fn));}
  sort(fn,order){return DA.fromValues([...this].sort((a,b)=>String(fn(a)).localeCompare(String(fn(b)))*(order==='desc'?-1:1)));}
  get file(){return {tasks:DA.fromValues(this.flatMap(p=>p.file.tasks))};}
}
function mockApp(legacy={routes:{},files:[]}){
  const files=new Map(),folders=new Set(),opens=[];
  const vault={adapter:{read:async p=>p==='.obsidian/plugins/light-okr/legacy-notes.json'?JSON.stringify(legacy):read(p)},getAbstractFileByPath:p=>files.get(p)||(folders.has(p)?{path:p,children:[]}:null),
    createFolder:async p=>{folders.add(p);},create:async(p,text)=>{if(files.has(p))throw Error('exists');const basename=path.posix.basename(p,'.md');const f={path:p,basename,extension:'md',text};files.set(p,f);return f;},
    read:async f=>f.text,cachedRead:async f=>f.text,modify:async(f,text)=>{f.text=text;},process:async(f,fn)=>{f.text=fn(f.text);},delete:async f=>{files.delete(f.path);},getFiles:()=>[...files.values()]};
  const app={vault,workspace:{getLeaf:()=>({openFile:async f=>opens.push(f.path)})},fileManager:{renameFile:async(f,p)=>{files.delete(f.path);f.path=p;files.set(p,f);}},plugins:{plugins:{}}};
  const adapter=new Adapter();Object.assign(adapter,{app,engine:new core.Engine(app),processing:new Set()});app.plugins.plugins['light-okr']=adapter;
  return {app,files,folders,opens,adapter};
}
const dateObj=s=>({toISODate:()=>s});
const task=(section,text,completed=false)=>({section:{subpath:section},text,completed});
async function main(){
  assert.equal(core.route('daily','2027-01-01'),'01. Daily/2027年/第1季度/01月/2026-W53/2027-01-01.md');
  assert.equal(core.route('weekly','2027-01-01'),'01. Daily/2026年/第4季度/12月/2026-W53/周计划.md');
  assert.equal(core.route('weekly','2027-01-03'),core.route('weekly','2026-12-28'));
  assert.equal(core.route('weekly','2026-10-01'),'01. Daily/2026年/第3季度/09月/2026-W40/周计划.md');
  for(const day of ['2024-02-29','2026-01-01','2026-03-31','2026-04-01','2026-06-30','2026-07-01','2026-09-30','2026-10-01','2026-12-31','2027-01-01'])for(const kind of Object.keys(core.templates)){
    const p=core.route(kind,day),id=core.identify(p);assert(id);assert.equal(core.route(kind,id.date),p);const c=core.context(kind,p);assert(c.start<=c.end);
  }
  assert.throws(()=>core.route('daily','2026-02-29'));
  assert.equal(core.identify('01. Daily/2021年/第1季度/01月/2021-W53/周计划.md'),null);
  assert.equal(core.context('monthly',core.route('monthly','2020-08-01')).weeks.split(' · ').length,6);
  assert(core.context('monthly',core.route('monthly','2024-02-01')).end.endsWith('-02-29'));
  const {app,adapter,files}=mockApp();
  for(const kind of Object.keys(core.templates)){
    const p=core.route(kind,'2026-10-16'),content=await adapter.engine.render(kind,p);assert(content.startsWith('---\n'));assert(!content.includes('<%'));assert(!/Score|contributionGraph|Academic gains/.test(content));
    for(const m of content.matchAll(/!\[\[([^#]+)#([^|]+)\|[^\]]+\]\]/g)){
      const target=m[1]+'.md',id=core.identify(target);assert(id);const parent=await adapter.engine.render(id.kind,target);assert(parent.includes('# '+m[2]+'\n'));
    }
  }
  const dayDoc=await adapter.engine.render('daily',core.route('daily','2026-10-16'));
  assert.deepEqual([...dayDoc.matchAll(/^# (.+)$/gm)].map(m=>m[1]),['习惯','任务','善意与美好','禅','改进','随笔']);
  for(const title of ['善意与美好','禅','改进','随笔'])assert.equal(core.section(dayDoc,title),'','空白模板提示不应成为正文 '+title);
  const weekDoc=await adapter.engine.render('weekly',core.route('weekly','2026-10-16'));
  assert.deepEqual([...weekDoc.matchAll(/^# (.+)$/gm)].map(m=>m[1]),['本周重点','周末回看']);
  assert.deepEqual([...weekDoc.matchAll(/^## (.+)$/gm)].map(m=>m[1]),['本周重点推进到哪了？','什么做法有效，什么问题反复出现？','下周接着做什么，准备怎么做？']);
  assert(weekDoc.includes('#本月重点|本月重点]]'));assert(!/engine\.view|dataviewjs/.test(weekDoc));
  assert.equal([...weekDoc.matchAll(/\|周[一二三四五六日]\]\]/g)].length,0);
  const crossYearWeek=await adapter.engine.render('weekly',core.route('weekly','2027-01-01'));
  for(const [day,label] of [['2026-12-21','上一周'],['2027-01-04','下一周']])assert(crossYearWeek.includes('[['+core.route('weekly',day).replace(/\.md$/,'')+'|'+label+']]'));
  const daily=await Promise.all(Array.from({length:5},()=>adapter.engine.ensure('daily','2027-01-01')));
  assert(daily.every(f=>f===daily[0]));assert.equal(files.size,8);
  for(const day of ['2026-12-28','2027-01-01'])for(const kind of ['yearly','quarterly','monthly','weekly'])assert(files.has(core.route(kind,day)),'首次创建缺少关联计划 '+kind+' '+day);
  for(const file of files.values())for(const m of file.text.matchAll(/!\[\[([^#]+)#([^|]+)\|[^\]]+\]\]/g))assert(files.has(m[1]+'.md'),'存在未补齐的上级引用 '+m[1]);
  daily[0].text+='\n自己的正文。';await adapter.engine.ensure('daily','2027-01-01');assert(daily[0].text.endsWith('自己的正文。'));
  const direct=await app.vault.create(core.route('daily','2026-10-16'),'');await adapter.created(direct);assert(direct.text.includes('# 随笔'));
  await app.vault.process(direct,current=>current+'\n剪藏测试内容');const saved=direct.text;await adapter.created(direct);assert.equal(direct.text,saved);
  const clip=await app.vault.create(core.route('daily','2026-10-17'),'首次剪藏测试内容');await adapter.created(clip);assert(clip.text.includes('type: daily'));assert(clip.text.endsWith('首次剪藏测试内容'));
  const manual=await app.vault.create('2026-10-18.md','独立记录');await adapter.created(manual);assert.equal(manual.path,'2026-10-18.md');assert.equal(manual.text,'独立记录');
  // Use the real Moment 2.29.4 bundled in Kanban to verify core/clipper paths.
  const kanban=read('.obsidian/plugins/obsidian-kanban/main.js');
  const momentStart=kanban.indexOf('var Wm=wn((Um,ls)=>'),momentEnd=kanban.indexOf('var dx=wn(',momentStart);
  assert(momentStart>=0&&momentEnd>momentStart,'Kanban Moment bundle changed; recheck date format');
  const momentVM={wn:fn=>{const m={exports:{}};fn(m.exports,m);return()=>m.exports;}};
  vm.runInNewContext(kanban.slice(momentStart,momentEnd)+';globalThis.moment=Wm();',momentVM);
  const settings=config('.obsidian/daily-notes.json');assert.equal(settings.folder,'');
  for(const day of ['2024-02-29','2026-03-31','2026-04-01','2026-09-30','2026-10-01','2026-12-31','2027-01-01','2027-01-04']){
    assert.equal(momentVM.moment(day,'YYYY-MM-DD',true).format(settings.format)+'.md',core.route('daily',day));
    assert(momentVM.moment(day,settings.format.split('/').pop(),true).isValid());
  }
  const emptyPlan=await app.vault.create(core.route('monthly','2028-04-01'),'');await adapter.created(emptyPlan);assert(emptyPlan.text.includes('# 本月重点'));
  assert(files.has(core.route('yearly','2028-04-01')));assert(files.has(core.route('quarterly','2028-04-01')));
  const controller={getNotePattern:()=>true,getNoteFilename:()=>null};app.plugins.plugins['dust-calendar']={noteController:controller};const old=controller.getNoteFilename;adapter.attachCalendar();
  for(const [type,kind] of [[1,'daily'],[2,'weekly'],[3,'monthly'],[4,'quarterly'],[5,'yearly']])assert.equal(controller.getNoteFilename(dateObj('2027-01-01'),type),core.route(kind,'2027-01-01'));
  adapter.disposers.forEach(fn=>fn());assert.equal(controller.getNoteFilename,old);
  // Confirm the bundled calendar calls the exact method covered by the adapter.
  const calendar=read('.obsidian/plugins/dust-calendar/main.js');assert(calendar.includes('this.getNoteFilename(date, noteType)'));assert(calendar.includes('const noteFilename = this.getNoteFilename(date, noteType);'));
  // Execute the real bundled Memory Orbs date-folder filter, with its parser stubbed.
  const memory=read('.obsidian/plugins/memory-orbs/main.js');const begin=memory.indexOf('var DiaryParser = class {'),end=memory.indexOf('var VIEW_TYPE_MEMORY_ORBS',begin);
  const memoryVM={Map,RegExp};vm.runInNewContext(memory.slice(begin,end)+';globalThis.Parser=DiaryParser;',memoryVM);const parser=new memoryVM.Parser(app,'','#Note/life/mood/','core',[]);parser.parseFile=async()=>[{text:'测试'}];
  const memories=await parser.getMemories('2026-12-28','2027-01-03');assert(memories.some(m=>m.date==='2027-01-01'));
  const start='2026-12-28',endDate='2027-01-03';
  const pages=DA.fromValues([
    {type:'daily',file:{name:'2026-12-28',path:core.route('daily','2026-12-28'),link:'周一',tasks:DA.fromValues([task('习惯','运动',true),task('任务','测试任务'),task('任务','')])}},
    {type:'daily',file:{name:'2027-01-01',path:core.route('daily','2027-01-01'),link:'周五',tasks:DA.fromValues([task('习惯','运动')])}},
    {type:'daily',file:{name:'2027-01-04',path:core.route('daily','2027-01-04'),link:'下周',tasks:DA.fromValues([task('习惯','不应出现',true)])}}
  ]);
  for(const page of pages)if(!files.has(page.file.path))await app.vault.create(page.file.path,'# 改进\n调整测试\n# 禅\n期待理解\n# 随笔\n> 引用保留\n');
  const reflectionFile=files.get(core.route('daily','2027-01-01'));
  reflectionFile.text=reflectionFile.text.replace('\n# 禅','\n朋友耐心听我说完了。\n\n# 禅');
  function mockDV(values){const output={tables:[],paragraphs:[],tasks:[],lists:[]};return {output,current:()=>({start:dateObj(start),end:dateObj(endDate)}),pages:()=>values,fileLink:(p,e,label)=>label||p,table:(h,r)=>output.tables.push({h,r}),paragraph:s=>output.paragraphs.push(s),taskList:t=>output.tasks.push(...t),list:l=>output.lists.push(l)};}
  for(const mode of ['habits','tasks','days','善意与美好','改进','禅','随笔']){
    const dv=mockDV(pages);await adapter.engine.view(dv,mode);
    assert(!JSON.stringify(dv.output).includes('不应出现'));
    if(mode==='habits'){const rows=dv.output.tables[0].r;assert.equal(rows.length,7);assert.equal(rows[0][1],'✓');assert.equal(rows[1][1],'未记录');assert.equal(rows[4][1],'○');}
    if(mode==='tasks')assert.deepEqual(dv.output.tasks.map(t=>t.text),['测试任务']);
    if(mode==='善意与美好'){assert(dv.output.paragraphs.includes('朋友耐心听我说完了。'));assert(!JSON.stringify(dv.output).includes('收到过什么善意'))};
    await adapter.engine.view(mockDV(DA.fromValues([])),mode);
  }
  const homePages=DA.fromValues([...pages,{type:'yearly',file:{name:'年度计划',path:core.route('yearly','2027-01-01')}}]);
  const home=mockDV(homePages);home.date=()=>dateObj('2027-01-01');const homeHeadings=[];home.header=(level,text)=>homeHeadings.push(text);
  await adapter.engine.home(home);assert.deepEqual(homeHeadings,['最近日记','按年浏览']);assert(home.output.paragraphs[0].includes('今天'));assert(home.output.lists.some(list=>list.includes('2027年')));
  const emptyHome=mockDV(DA.fromValues([]));emptyHome.date=home.date;emptyHome.header=()=>{};await adapter.engine.home(emptyHome);assert(emptyHome.output.paragraphs.some(text=>text.includes('01. Daily')));
  // Old notes are opened in place, including blank originals, with no template or ancestor insertion.
  const oldDayPath=core.route('daily','2026-08-05'),oldWeekPath='01. Daily/2026年/第3季度/08月/2026-W32/2026-W32.md';
  const oldMonthPath='01. Daily/2026年/第3季度/08月/2026-M08.md',oldYearPath='01. Daily/2026年/2026-Overview.md';
  const oldIndex={routes:{[oldDayPath]:oldDayPath,[core.route('weekly','2026-08-05')]:oldWeekPath,[core.route('monthly','2026-08-05')]:oldMonthPath,[core.route('yearly','2026-08-05')]:oldYearPath},files:[{path:oldDayPath,kind:'daily'},{path:oldWeekPath,kind:'weekly'},{path:oldMonthPath,kind:'monthly'},{path:oldYearPath,kind:'yearly'}]};
  const oldVault=mockApp(oldIndex);oldVault.app.metadataCache={getFileCache:f=>{assert(f,'Do not look up metadata for a missing file');return null;}};
  const oldDay=await oldVault.app.vault.create(oldDayPath,'## 旧标题\n自己的原文\n');
  const oldWeek=await oldVault.app.vault.create(oldWeekPath,'# 📌 本周最高优先级\n原来的安排\n');
  await oldVault.app.vault.create(oldMonthPath,'# ✨ 最值得将时间投资在什么事情上？\n原来的月重点\n');
  await oldVault.app.vault.create(oldYearPath,'# 🎯年度核心目标\n原来的年重点\n');
  const oldCount=oldVault.files.size;
  assert.equal(await oldVault.adapter.engine.ensure('daily','2026-08-05'),oldDay);assert.equal(oldVault.files.size,oldCount);
  await oldVault.adapter.created(oldDay);assert.equal(oldDay.text,'## 旧标题\n自己的原文\n');assert.equal(oldVault.files.size,oldCount);
  assert.equal(await oldVault.adapter.engine.ensure('weekly','2026-08-05'),oldWeek);
  oldWeek.text='';await oldVault.adapter.engine.ensure('weekly','2026-08-05');assert.equal(oldWeek.text,'');oldWeek.text='# 📌 本周最高优先级\n原来的安排\n';
  const newAlongsideOld=await oldVault.adapter.engine.ensure('daily','2026-08-06');assert(newAlongsideOld.text.includes('type: daily'));assert(newAlongsideOld.text.includes(oldWeekPath.replace(/\.md$/,'')+'#📌 本周最高优先级|本周重点]]'));assert(newAlongsideOld.text.includes(oldYearPath.replace(/\.md$/,'')));
  const oldController={getNotePattern:()=>true,getNoteFilename:()=>null};oldVault.app.plugins.plugins['dust-calendar']={noteController:oldController};oldVault.adapter.attachCalendar();assert.equal(oldController.getNoteFilename(dateObj('2026-08-05'),2),oldWeekPath);
  const untyped=DA.fromValues([{file:{name:'2026-08-05',path:oldDayPath,link:'旧日记',tasks:DA.fromValues([])}},{file:{name:'2026-Overview',path:oldYearPath,link:'旧年记',tasks:DA.fromValues([])}}]);
  assert.equal(oldVault.adapter.engine.dailyPages({pages:()=>untyped},'2026-08-01','2026-08-31').length,1);
  const oldHome=mockDV(untyped);oldHome.date=()=>dateObj('2026-08-05');oldHome.header=()=>{};await oldVault.adapter.engine.home(oldHome);assert(oldHome.output.lists.some(l=>l.includes('旧日记')));assert(oldHome.output.lists.some(l=>l.includes('2026年')));
  assert.equal(core.section('# 随笔\n~~~js\n# 保留代码\n~~~\n> 引用\n','随笔'),'~~~js\n# 保留代码\n~~~\n> 引用');
  assert.equal(core.section('# 随笔\n~~~html\n<!-- 代码注释保留 -->\n~~~\n','随笔'),'~~~html\n<!-- 代码注释保留 -->\n~~~');
  const enabled=config('.obsidian/community-plugins.json'),inventory=config('.dev/适配清单.json');
  assert.equal(new Set(inventory.plugins).size,25);
  assert.deepEqual(enabled,inventory.plugins.filter(id=>!(inventory.disabledByDefault||[]).includes(id)));
  for(const id of inventory.plugins){assert.equal(config('.obsidian/plugins/'+id+'/manifest.json').id,id);assert(fs.existsSync(path.join(root,'.obsidian/plugins',id,'main.js')));}
  assert.equal(config('.obsidian/templates.json').folder,'Template');
  assert.equal(config('.obsidian/plugins/templater-obsidian/data.json').templates_folder,'Template');
  assert.equal(config('.obsidian/plugins/homepage/data.json').homepages['Main Homepage'].value,'MOC');
  assert.equal(config('.obsidian/plugins/homepage/data.json').homepages['Main Homepage'].view,'Reading view');
  assert.equal(config('.obsidian/appearance.json').cssTheme,'Blue Topaz');
  assert(fs.existsSync(path.join(root,'.obsidian/themes/Blue Topaz/theme.css')));
  for(const name of Object.values(core.templates))assert(fs.existsSync(path.join(root,'Template',name+'.md')));
  assert(read('MOC.md').includes('countField:\n    type: DEFAULT'));
  assert(!/Score|PAGE_PROPERTY/.test(read('MOC.md')));
  function walk(dir){for(const name of fs.readdirSync(dir)){const p=path.join(dir,name),s=fs.statSync(p);if(s.isDirectory())walk(p);else if(name.endsWith('.json'))JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));}}
  walk(path.join(root,'.obsidian'));
  for(const filename of ['.obsidian/plugins/templater-obsidian/data.json','.obsidian/plugins/homepage/data.json','.obsidian/plugins/dust-calendar/data.json','.obsidian/app.json'])assert(!/01\. Daily\/(?:Day|Weekly|Month|Phase|Year)[/"']/.test(read(filename)));
  assert.equal(config('.obsidian/plugins/templater-obsidian/data.json').trigger_on_file_creation,false);
  assert.equal(config('.obsidian/plugins/dust-calendar/data.json').templatePlugin,0);
  console.log('PASS: natural-year/quarter boundaries; unique cross-year week and adjacent-week navigation; leap/six-week month; 5 templates and linked headings; prompt-free reflection extraction; concurrent creation; ancestor plans auto-created on both sides of year boundary; preserve existing writing; direct daily creation and first clipping; real Moment core/clipper path formatting; calendar attachment/unload; real Memory Orbs filter; 7 Dataview views and diary/year index; legacy notes preserved without template insertion or extra ancestors; untyped historical notes indexed; new notes link to old parent headings; 25 manifests; Template/MOC/Blue Topaz integration; count-only diary graph; all JSON configs.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
