const DAY = 86400000;
const ROOT = '01. Daily';
const pad = n => String(n).padStart(2,'0');
const iso = d => d.toISOString().slice(0,10);
const date = (y,m,d) => new Date(Date.UTC(y,m-1,d));
const add = (d,n) => new Date(d.getTime()+n*DAY);
function parse(value) {
  const s = typeof value === 'string' ? value : value.toISODate();
  const d = date(...s.split('-').map(Number));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(d.getTime()) || iso(d)!==s) throw Error('日期格式应为 YYYY-MM-DD');
  return d;
}
function week(d) {
  const mon = add(d,1-(d.getUTCDay()||7));
  const thu = add(mon,3), year=thu.getUTCFullYear();
  return {mon,key:year+'-W'+pad(Math.ceil(((thu-date(year,1,1))/DAY+1)/7))};
}
function monthFolder(d) { return ROOT+'/'+d.getUTCFullYear()+'年/第'+Math.ceil((d.getUTCMonth()+1)/3)+'季度/'+pad(d.getUTCMonth()+1)+'月'; }
function route(kind,input) {
  const d=parse(input), y=d.getUTCFullYear(), m=d.getUTCMonth()+1, q=Math.ceil(m/3), w=week(d);
  if(kind==='daily') return monthFolder(d)+'/'+w.key+'/'+iso(d)+'.md';
  if(kind==='weekly') return monthFolder(new Date(Math.max(w.mon,date(y,1,1))))+'/'+w.key+'/周计划.md';
  if(kind==='monthly') return monthFolder(d)+'/月度计划.md';
  if(kind==='quarterly') return ROOT+'/'+y+'年/第'+q+'季度/季度计划.md';
  if(kind==='yearly') return ROOT+'/'+y+'年/年度计划.md';
  throw Error('未知周期 '+kind);
}
function identify(file) {
  let m=file.match(/(?:^|\/)(\d{4}-\d{2}-\d{2})\.md$/);
  if(m) return {kind:'daily',date:m[1]};
  m=file.match(/^01\. Daily\/(\d{4})年\/(?:第([1-4])季度\/)?(?:(\d{2})月\/)?(?:(\d{4})-W(\d{2})\/)?(年度计划|季度计划|月度计划|周计划)\.md$/);
  if(!m) return null;
  const kind=({年度计划:'yearly',季度计划:'quarterly',月度计划:'monthly',周计划:'weekly'})[m[6]];
  let d=date(+m[1], m[3]?+m[3]:m[2]?(+m[2]-1)*3+1:1,1);
  if(kind==='weekly') {
    if(!m[4]||!m[5]) return null;
    const jan4=date(+m[4],1,4); d=add(jan4,1-(jan4.getUTCDay()||7)+(+m[5]-1)*7);
    d=new Date(Math.max(d,date(+m[1],1,1)));
    if(week(d).key!==m[4]+'-W'+m[5]) return null;
  }
  const s=iso(d);
  return route(kind,s)===file?{kind,date:s}:null;
}
const link=(p,label,heading)=>'[['+p.replace(/\.md$/,'')+(heading?'#'+heading:'')+'|'+label+']]';
function context(kind,file) {
  const identified=identify(file); if(!identified || identified.kind!==kind) throw Error('请从首页或日历创建周期笔记');
  const d=parse(identified.date), y=d.getUTCFullYear(), m=d.getUTCMonth()+1, q=Math.ceil(m/3), w=week(d);
  let first=d,last=d;
  if(kind==='weekly') {first=new Date(Math.max(w.mon,date(y,1,1)));last=new Date(Math.min(add(w.mon,6),date(y,12,31)));}
  if(kind==='monthly') {first=date(y,m,1);last=add(date(y,m+1,1),-1);}
  if(kind==='quarterly') {first=date(y,(q-1)*3+1,1);last=add(date(y,q*3+1,1),-1);}
  if(kind==='yearly') {first=date(y,1,1);last=date(y,12,31);}
  const weeks=[...new Set(Array.from({length:Math.round((last-first)/DAY)+1},(_,i)=>route('weekly',iso(add(first,i)))))];
  const parents={daily:['weekly','本周重点','本周重点'],weekly:['monthly','本月重点','本月重点'],monthly:['quarterly','本季重点','本季重点'],quarterly:['yearly','今年重点','今年重点']};
  const parent=parents[kind];
  return {kind,date:iso(d),start:iso(first),end:iso(last),year:y,quarter:q,month:m,week:w.key,
    parent:parent?'!'+link(route(parent[0],iso(d)),parent[1],parent[2]):'',
    yearLink:link(route('yearly',iso(d)),y+'年'),quarterLink:link(route('quarterly',iso(d)),'第'+q+'季度'),monthLink:link(route('monthly',iso(d)),pad(m)+'月'),weekLink:link(route('weekly',iso(d)),w.key),
    previousWeekLink:link(route('weekly',iso(add(new Date(Math.max(w.mon,date(y,1,1))),-1))),'上一周'),nextWeekLink:link(route('weekly',iso(add(new Date(Math.min(add(w.mon,6),date(y,12,31))),1))),'下一周'),
    days:Array.from({length:Math.round((last-first)/DAY)+1},(_,i)=>{const dt=add(first,i);return link(route('daily',iso(dt)),['周一','周二','周三','周四','周五','周六','周日'][(dt.getUTCDay()||7)-1]);}).join(' · '),
    weeks:weeks.map(p=>link(p,p.match(/\d{4}-W\d{2}/)[0])).join(' · '),
    months:Array.from({length:kind==='yearly'?12:3},(_,i)=>{const mm=kind==='yearly'?i+1:(q-1)*3+i+1;return link(route('monthly',iso(date(y,mm,1))),pad(mm)+'月');}).join(' · '),
    quarters:[1,2,3,4].map(n=>link(route('quarterly',iso(date(y,(n-1)*3+1,1))),'第'+n+'季度')).join(' · ')};
}
function section(content,title) {
  const hints=new Set([
    '> 今天哪件事，下次可以换个做法？有具体发现再写。',
    '> 今天，我在期望什么？从哪件事、哪个念头或哪种情绪里看到了它？',
    '> 今天，我收到过什么善意或支持？',
    '> 今天，我怎样善待了别人或自己？',
    '> 今天，哪个小片刻让我觉得还不错？',
    '> 今天什么事情、念头或情绪牵动了我？',
    '> 我在期待什么、在意什么？',
    '> 其中有哪些事实，哪些是我的解释？',
    '> 今天有没有哪件事，下次可以换个做法？有具体发现再写。',
    '> 遇到失误时，如果是朋友遇到这件事，我会怎样理解他？'
  ]);
  const lines=content.split(/\r?\n/);let active=false,fence=null,out=[];
  for(const line of lines) {
    const f=line.match(/^\s*(`{3,}|~{3,})/);
    if(f) {if(!fence)fence=f[1][0];else if(fence===f[1][0])fence=null;}
    if(!fence && /^# /.test(line)) {if(active)break;active=line.trim()==='# '+title;continue;}
    if(active&&(fence||(!hints.has(line.trim())&&!/^\s*<!--.*-->\s*$/.test(line))))out.push(line);
  }
  return out.join('\n').trim();
}
const templates={daily:'日记模版',weekly:'周记模版',monthly:'月度反思模版',quarterly:'季度计划模版',yearly:'年度反思模版'};
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function evaluate(text,tp) {
  let code="let tR='';\n",p=0;
  for(const m of text.matchAll(/<%(\*?)([\s\S]*?)%>/g)) {
    code+='tR+='+JSON.stringify(text.slice(p,m.index))+';\n';code+=m[1]?m[2]+'\n':'tR+=('+m[2]+');\n';p=m.index+m[0].length;
  }
  return new AsyncFunction('tp',code+'tR+='+JSON.stringify(text.slice(p))+';return tR;')(tp);
}
class Engine {
  constructor(app){this.app=app;this.pending=new Map();this.legacy={routes:{},files:[]};this.legacyFiles=new Map();this.headingCache=new Map();}
  async loadLegacy(){
    if(!this.legacyLoad)this.legacyLoad=(async()=>{try{const data=JSON.parse(await this.app.vault.adapter.read('.obsidian/plugins/light-okr/legacy-notes.json'));this.legacy={routes:data.routes||{},files:data.files||[]};this.legacyFiles=new Map(this.legacy.files.map(f=>[f.path,f]));}catch(e){this.legacy={routes:{},files:[]};}})();
    return this.legacyLoad;
  }
  legacyPath(canonical){const old=this.legacy.routes[canonical];if(canonical.endsWith('/周计划.md')&&canonical.match(/\/(\d{4})年\//)?.[1]!==old?.match(/(?:^|\/)(\d{4})年\//)?.[1])return canonical;return old&&this.app.vault.getAbstractFileByPath?.(old)?old:canonical;}
  path(kind,value){return this.legacyPath(route(kind,value));}
  context(kind,file){
    const c=context(kind,file);
    const rewrite=text=>text.replace(/\[\[([^#|\]]+)(#[^|\]]+)?(\|[^\]]+)?\]\]/g,(all,p,h='',label='')=>{const actual=this.legacyPath(p+'.md');return actual!==p+'.md'?'[['+actual.replace(/\.md$/,'')+h+label+']]':all;});
    for(const key of Object.keys(c))if(typeof c[key]==='string')c[key]=rewrite(c[key]);
    const m=c.parent.match(/^!\[\[([^#|]+)#([^|]+)\|([^\]]+)\]\]$/);
    if(m){const p=m[1]+'.md',f=this.app.vault.getAbstractFileByPath?.(p);const cached=f?this.app.metadataCache?.getFileCache?.(f)?.headings?.map(h=>h.heading):undefined;const headings=this.headingCache.get(p)||cached;
      if(headings&&!headings.includes(m[2])){const aliases={'本周重点':['📌 本周最高优先级'],'本月重点':['✨ 最值得将时间投资在什么事情上？'],'本季重点':['🎯核心目标'],'今年重点':['🎯年度核心目标']};const heading=(aliases[m[2]]||[]).find(h=>headings.includes(h));c.parent='!'+link(p,m[3],heading);}
    }
    return c;
  }
  async render(kind,file){
    await this.loadLegacy();
    const c=this.context(kind,file),m=c.parent.match(/^!\[\[([^#|]+)/);
    if(m){const p=m[1]+'.md',f=this.app.vault.getAbstractFileByPath?.(p);if(f){const body=await this.app.vault.cachedRead(f);let fence=null;const headings=[];for(const line of body.split(/\r?\n/)){const marker=line.match(/^\s*(`{3,}|~{3,})/);if(marker){fence=fence?(fence===marker[1][0]?null:fence):marker[1][0];continue;}const h=!fence&&line.match(/^#{1,6}\s+(.+?)\s*$/);if(h)headings.push(h[1]);}this.headingCache.set(p,headings);}}
    const text=await this.app.vault.adapter.read('Template/'+templates[kind]+'.md');return evaluate(text,{app:this.app,config:{target_file:{path:file}}});
  }
  async folders(file){const parts=file.split('/');parts.pop();let p='';for(const s of parts){p=p?p+'/'+s:s;if(!this.app.vault.getAbstractFileByPath(p)){try{await this.app.vault.createFolder(p);}catch(e){if(!this.app.vault.getAbstractFileByPath(p))throw e;}}}}
  async ensureParents(kind,value){
    const canonical=route(kind,value),actual=identify(canonical).date;
    const parents={daily:['monthly','weekly'],weekly:['monthly'],monthly:['quarterly'],quarterly:['yearly'],yearly:[]};
    for(const parent of parents[kind])await this.ensure(parent,actual);
  }
  async ensure(kind,value){await this.loadLegacy();const p=this.path(kind,value);if(this.pending.has(p))return this.pending.get(p);const job=(async()=>{let f=this.app.vault.getAbstractFileByPath(p);if(f&&this.legacyFiles.has(p))return f;await this.ensureParents(kind,value);await this.folders(p);f=this.app.vault.getAbstractFileByPath(p);if(!f){try{f=await this.app.vault.create(p,await this.render(kind,p));}catch(e){f=this.app.vault.getAbstractFileByPath(p);if(!f)throw e;}}else if(!(await this.app.vault.read(f)).trim()){await this.app.vault.modify(f,await this.render(kind,p));}return f;})();this.pending.set(p,job);try{return await job;}finally{this.pending.delete(p);}}
  async open(kind,value){const file=await this.ensure(kind,value);await this.app.workspace.getLeaf(false).openFile(file);return file;}
  dailyPages(dv,start,end){return dv.pages().where(p=>(p.type==='daily'||/^\d{4}-\d{2}-\d{2}$/.test(p.file.name))&&p.file.name>=start&&p.file.name<=end&&p.file.path.startsWith(ROOT+'/')).sort(p=>p.file.name,'asc');}
  range(dv){const c=dv.current();const s=v=>typeof v==='string'?v:v.toISODate();return [s(c.start),s(c.end)];}
  async view(dv,mode){const [start,end]=this.range(dv),pages=this.dailyPages(dv,start,end);
    if(mode==='habits') {
      const tasks=p=>Array.from(p.file.tasks).filter(t=>t.section?.subpath==='习惯'&&t.text.trim());
      const names=[...new Set(Array.from(pages).flatMap(p=>tasks(p).map(t=>t.text.trim())))];
      if(!names.length){dv.paragraph('暂无习惯记录。');return;}
      const map=new Map(Array.from(pages).map(p=>[p.file.name,p]));
      const rows=Array.from({length:Math.round((parse(end)-parse(start))/DAY)+1},(_,i)=>{const d=iso(add(parse(start),i)),p=map.get(d);return [dv.fileLink(route('daily',d),false,d.slice(5)),...names.map(n=>!p?'未记录':tasks(p).find(t=>t.text.trim()===n)?.completed?'✓':tasks(p).some(t=>t.text.trim()===n)?'○':'—')];});
      dv.table(['日期',...names],rows);dv.paragraph('✓ 已勾选 · ○ 未勾选 · — 当天未列此项 · 未记录：没有当天日记');return;
    }
    if(mode==='tasks'){const tasks=pages.file.tasks.where(t=>t.section?.subpath==='任务'&&t.text.trim());if(tasks.length)dv.taskList(tasks,true);else dv.paragraph('暂无日任务。');return;}
    if(mode==='days'){if(pages.length)dv.list(pages.map(p=>p.file.link));else dv.paragraph('暂无日记。');return;}
    if(['善意与美好','改进','禅','随笔'].includes(mode)){let count=0;for(const p of pages){const body=section(await this.app.vault.cachedRead(this.app.vault.getAbstractFileByPath(p.file.path)),mode);if(body){dv.paragraph('**'+dv.fileLink(p.file.path,false,p.file.name)+'**');dv.paragraph(body);count++;}}if(!count)dv.paragraph('暂无'+mode+'记录。');}
  }
  async home(dv){
    await this.loadLegacy();
    const local=dv.date('today').toISODate();
    dv.paragraph(['daily','weekly','monthly','quarterly','yearly'].map((k,i)=>dv.fileLink(this.path(k,local),false,['今天','本周','本月','本季','今年'][i])).join(' · '));
    dv.header(3,'最近日记');
    const pages=dv.pages().where(p=>(p.type==='daily'||/^\d{4}-\d{2}-\d{2}$/.test(p.file.name))&&p.file.path.startsWith(ROOT+'/')).sort(p=>p.file.name,'desc');
    if(pages.length)dv.list(pages.slice(0,7).map(p=>p.file.link));
    else dv.paragraph('日记保存在 01. Daily。点击“今天”或选择日历日期，自动创建年、季、月、周计划与当天日记。');
    dv.header(3,'按年浏览');
    const years=dv.pages().where(p=>(p.type==='yearly'||this.legacyFiles.get(p.file.path)?.kind==='yearly'||identify(p.file.path)?.kind==='yearly')&&p.file.path.startsWith(ROOT+'/')).sort(p=>p.file.path,'desc');
    if(years.length)dv.list(years.map(p=>dv.fileLink(p.file.path,false,p.file.path.match(/\/(\d{4})年\//)[1]+'年')));
    else dv.paragraph('开始记录后，这里自动显示年份目录。');
    const others=dv.pages().where(p=>['collection','variant'].includes(this.legacyFiles.get(p.file.path)?.kind)).sort(p=>p.file.path,'asc');
    if(others.length){dv.header(3,'合并记录与其他版本');dv.list(others.map(p=>p.file.link));}
  }
}
module.exports={Engine,route,context,identify,parse,date,iso,add,week,section,evaluate,templates};
