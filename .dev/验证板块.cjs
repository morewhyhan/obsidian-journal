const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
class Element {
  constructor(tag,options={}){this.tag=tag;this.options=options;this.children=[];this.style={};this.events={};this.textContent=options.text||'';}
  createEl(tag,o){const child=new Element(tag,o);this.children.push(child);return child;}
  createSpan(){return this.createEl('span');}
  querySelector(){return null;}
  addEventListener(event,fn){this.events[event]=fn;}
  setText(text){this.textContent=text;}
  focus(){this.focused=true;}
  empty(){this.children=[];}
}
class Modal {constructor(app){this.app=app;this.titleEl=new Element('h2');this.contentEl=new Element('div');}open(){this.opened=true;this.onOpen();}close(){this.opened=false;this.onClose();}}
class Plugin {constructor(){this.commands=[];this.ribbons=[];}addCommand(c){this.commands.push(c);}addRibbonIcon(icon,title,fn){this.ribbons.push({icon,title,fn});}registerEvent(){}register(){}registerInterval(){}}
class Pages extends Array {where(fn){return Pages.from(this.filter(fn));}sort(fn,order){return Pages.from([...this].sort((a,b)=>String(fn(a)).localeCompare(String(fn(b)))*(order==='desc'?-1:1)));}}
async function main(){
  const files=new Map(),folders=new Map(),opened=[];
  const app={vault:{adapter:{read:async p=>p.endsWith('legacy-notes.json')?'{"routes":{},"files":[]}':read(p)},on:()=>{},getAbstractFileByPath:p=>files.get(p)||folders.get(p),createFolder:async p=>folders.set(p,{path:p,children:[]}),create:async(p,text)=>{if(files.has(p))throw Error('exists');const f={path:p,text,extension:'md'};files.set(p,f);return f;},read:async f=>f.text},workspace:{onLayoutReady:()=>{},getLeaf:()=>({openFile:async f=>opened.push(f.path)})},plugins:{plugins:{}}};
  const sandbox={module:{exports:{}},require:id=>{assert.equal(id,'obsidian','Obsidian 只需提供宿主 API，本地模块必须已打包');return {Plugin,Modal,Notice:class{}};},console,setTimeout,clearTimeout,setInterval};
  vm.runInNewContext(read('.obsidian/plugins/light-okr/main.js'),sandbox);
  const plugin=new sandbox.module.exports();plugin.app=app;app.plugins.plugins['light-okr']=plugin;await plugin.onload();
  for(const id of ['open-workspace','open-daily','open-weekly','open-monthly','open-quarterly','open-yearly'])assert(plugin.commands.some(c=>c.id===id));
  assert(!plugin.commands.some(c=>['new-decision','new-manual','add-entry-material'].includes(c.id)));
  assert.equal(plugin.newEntry,undefined);assert.equal(plugin.entries,undefined);
  files.set('MOC.md',{path:'MOC.md',extension:'md'});await plugin.openWorkspace();assert.equal(opened.at(-1),'MOC.md');
  // Homepage rendering never creates notes; actions resolve the date when clicked.
  const roots=[],links=[];let localDate='2026-10-17';
  app.workspace.openLinkText=async(...args)=>links.push(args);
  const homepagePages=Pages.from([
    ...Array.from({length:8},(_,i)=>({file:{name:'2026-10-'+String(i+1).padStart(2,'0'),path:'01. Daily/2026年/2026-10-'+String(i+1).padStart(2,'0')+'.md'}})),
    {type:'daily',file:{name:'2099-01-01',path:'Attachment/2099-01-01.md'}},
    {file:{name:'周计划',path:'01. Daily/2026年/周计划.md'}}
  ]);
  // Use the installed Dataview's real element/Markdown rendering functions:
  // dv.el('div', '') inserts a span, which must not become a fourth grid item.
  const dataviewSource=read('.obsidian/plugins/dataview/main.js');
  const extractFunction=name=>{const start=dataviewSource.indexOf('async function '+name+'(');assert(start>=0);return dataviewSource.slice(start,dataviewSource.indexOf('\n}',start)+2);};
  const rendering={Values:{wrapValue:value=>value==null?null:{value},isNull:v=>v==null,isDate:()=>false,isDuration:()=>false,isString:v=>typeof v==='string',isBoolean:v=>typeof v==='boolean',isNumber:v=>typeof v==='number'},obsidian:{MarkdownRenderer:{render:async()=>{}}}};
  rendering.renderCompactMarkdown=vm.runInNewContext('('+extractFunction('renderCompactMarkdown')+')',rendering);
  rendering.renderValue=vm.runInNewContext('('+extractFunction('renderValue')+')',rendering);
  const elStart=dataviewSource.indexOf('    el(el, text, { container = this.container');assert(elStart>=0);
  const elMethod=dataviewSource.slice(elStart,dataviewSource.indexOf('\n    /**',elStart));
  const realDataviewEl=vm.runInNewContext('({'+elMethod+'}).el',rendering);
  const container={createEl:(tag,options)=>{const el=new Element(tag,options);roots.push(el);return el;}};
  const homeDV={container,el:realDataviewEl,settings:{maxRecursiveRenderDepth:6},date:()=>({toISODate:()=>localDate}),pages:q=>{assert.equal(q,'"01. Daily"');return homepagePages;}};
  const countBefore=files.size;
  await plugin.dashboard.start(homeDV);plugin.dashboard.navigation(homeDV);plugin.dashboard.recent(homeDV);
  assert.equal(files.size,countBefore);
  const descendants=el=>[el,...el.children.flatMap(descendants)];
  const all=roots.flatMap(descendants);
  assert(all.some(el=>el.textContent==='2026年10月17日 · 星期六'));
  const recent=roots.find(el=>el.options.cls==='journal-recent'),recentList=recent.children.find(el=>el.tag==='ul');
  assert.equal(recentList.children.length,5);assert.equal(recentList.children[0].children[0].textContent,'2026-10-08');
  assert(!descendants(recent).some(el=>el.textContent==='2099-01-01'));
  const calls=[],oldOpen=plugin.engine.open;
  plugin.engine.open=async(kind,date)=>calls.push([kind,date]);localDate='2026-10-18';
  for(const title of ['写今天的日记','本周','本月','本季','今年'])await all.find(el=>el.tag==='button'&&el.textContent===title).events.click();
  assert.deepEqual(calls,[['daily','2026-10-18'],['weekly','2026-10-18'],['monthly','2026-10-18'],['quarterly','2026-10-18'],['yearly','2026-10-18']]);
  plugin.engine.open=oldOpen;
  const cards=roots.find(el=>el.options.cls==='journal-blocks');
  assert(!descendants(cards).some(el=>el.tag==='button'));assert.equal(cards.children.length,3);
  await recentList.children[0].children[0].events.click({preventDefault(){},stopPropagation(){},ctrlKey:true});
  assert.deepEqual(links.at(-1),['01. Daily/2026年/2026-10-08.md','MOC.md',true]);
  homeDV.pages=()=>Pages.from([]);plugin.dashboard.recent(homeDV);assert(descendants(roots.at(-1)).some(el=>el.textContent.includes('还没有日记')));
  localDate='2026-10-17';const existingDay=plugin.engine.path('daily',localDate);files.set(existingDay,{path:existingDay,extension:'md'});await plugin.dashboard.start(homeDV);
  assert(descendants(roots.at(-1)).some(el=>el.textContent==='继续今天的日记'));files.delete(existingDay);
  for(const name of ['MOC.md','README.md','01. Daily/README.md','02. Decisions/README.md','03. Manual/README.md']){
    const text=read(name);
    for(const match of text.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g)){const target=match[1].replace(/\\$/,'');assert(fs.existsSync(path.join(root,target+'.md')),'入口链接不存在 '+target);}
    for(const match of text.matchAll(/\[首页\]\(([^)]+)\)/g))assert.equal(path.resolve(root,path.dirname(name),match[1]),path.join(root,'MOC.md'));
    for(const match of text.matchAll(/(?<!!)\[[^\]\n]+\]\((?:<([^>]+)>|([^\s)]+))\)/g)){
      const target=match[1]||match[2];if(/^[a-z]+:/i.test(target)||target.startsWith('#'))continue;
      assert(fs.existsSync(path.resolve(root,path.dirname(name),decodeURIComponent(target.split('#')[0]))),'README 本地链接不存在 '+target);
    }
  }
  const json=p=>JSON.parse(read(p));assert.equal(json('.obsidian/plugins/homepage/data.json').homepages['Main Homepage'].value,'MOC');
  assert(json('.obsidian/appearance.json').enabledCssSnippets.includes('workspace-navigation'));
  assert(json('.obsidian/appearance.json').enabledCssSnippets.includes('journal-home'));
  const icons=json('.obsidian/plugins/obsidian-icon-folder/data.json');assert.notEqual(icons.settings.iconColor,'#ff0a3b');assert.equal(new Set(['01. Daily','02. Decisions','03. Manual'].map(p=>icons[p].iconColor)).size,3);
  assert(read('.obsidian/plugins/obsidian-icon-folder/main.js').includes("iconNode.classList.add('iconize-icon')"));assert(read('.obsidian/snippets/workspace-navigation.css').includes(':has(.iconize-icon)'));
  console.log('PASS: simple Decisions/Manual directories; obsolete creation commands removed; homepage cards use directory links; MOC startup and all 5 diary/plan actions; click-time date resolution; read-only dashboard render; recent and empty states; local links and distinct navigation icons.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
