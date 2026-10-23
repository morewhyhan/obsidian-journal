const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const core=require('../.obsidian/plugins/light-okr/core');
const root=path.resolve(__dirname,'..'),snapshot=path.join(root,'.local/日记整理');
const previous=JSON.parse(fs.readFileSync(path.join(snapshot,'整理清单.json'),'utf8'));
const backup=path.join(root,'.local/旧笔记原样恢复');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const sources={日记:'C:/Users/why/Documents/日记',原库日记:'C:/Users/why/Documents/example-obsidian-library-of-dice/01. Daily'};
const outputs=new Map(),records=[],routes={},aliases=new Map();
const safe=relative=>{const full=path.resolve(root,relative);assert(full.startsWith(root+path.sep),'越界路径 '+relative);return full;};
const folder=(kind,date)=>path.posix.dirname(core.route(kind,date));
const date=(y,m,d)=>{const s=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;core.parse(s);return s;};
function registerAlias(rec){
  for(const a of [rec.relative,rec.relative.replace(/\.md$/,''),path.posix.basename(rec.relative),path.posix.basename(rec.relative,'.md')]){
    if(!aliases.has(a))aliases.set(a,new Set());aliases.get(a).add(rec.target);
  }
}
function locate(rec){
  const base=path.posix.basename(rec.relative,'.md');let m,kind,day,target;
  if(base==='MOC'||/日记模[板版]$/.test(base))return {status:'仅保留原件（旧入口或旧模板）'};
  if(/^20\d{2}-\d{2}-\d{2}$/.test(base)){kind='daily';day=base;target=core.route(kind,day);}
  else if((m=base.match(/^(20\d{2})-W(\d{2})$/))){
    kind='weekly';const jan4=core.date(+m[1],1,4);day=core.iso(core.add(jan4,1-(jan4.getUTCDay()||7)+(+m[2]-1)*7));
    assert.equal(core.week(core.parse(day)).key,base);target=folder(kind,day)+'/'+base+'.md';
  }else if((m=base.match(/^(20\d{2})-M(\d{2})$/))){kind='monthly';day=date(+m[1],+m[2],1);target=folder(kind,day)+'/'+base+'.md';}
  else if((m=base.match(/^(20\d{2})-Q0?([1-4])$/))){kind='quarterly';day=date(+m[1],(+m[2]-1)*3+1,1);target=folder(kind,day)+'/'+base+'.md';}
  else if((m=base.match(/^(20\d{2})-Overview$/))){kind='yearly';day=m[1]+'-01-01';target=folder(kind,day)+'/'+base+'.md';}
  else if(base==='长期待办任务'){kind='goals';target='长期待办任务.md';}
  else if((m=base.match(/^(20\d{2})-(\d{1,2})$/))){kind='collection';day=date(+m[1],+m[2],1);target=folder('monthly',day)+'/'+base+'.md';}
  else if(base==='寒假okr'){kind='monthly';day='2026-01-01';target=folder(kind,day)+'/'+base+'.md';rec.placement='旧库年末跨年计划中的1月，沿用前次依据上下文归入2026年1月的定位。';}
  else if((m=base.match(/^(\d{1,2})月(\d{1,2})日?[-—]/))){
    kind='weekly';day=date(+(rec.relative.match(/(20\d{2})年/)||[])[1],+m[1],+m[2]);
    if(day==='2025-11-09'&&base==='11月9日-11月16日'){
      day='2025-11-10';rec.placement='原文件名从周日开始，正文包含11月13日和14日，归入11月10日开始的一周；文件名及正文保持原样。';
    }
    target=folder(kind,day)+'/'+base+'.md';
  }
  else if(/^(月OKR|月目标)$/.test(base)){
    kind='monthly';day=date(+(rec.relative.match(/(20\d{2})年/)||[])[1],+(rec.relative.match(/\/(\d{1,2})月\//)||[])[1],1);target=folder(kind,day)+'/'+base+'.md';
  }else if(base==='年OKR'){kind='yearly';day=(rec.relative.match(/(20\d{2})年/)||[])[1]+'-01-01';target=folder(kind,day)+'/'+base+'.md';}
  else if(base==='季度OKR'){
    kind='quarterly';const year=+(rec.relative.match(/(20\d{2})年/)||[])[1],q=+(rec.relative.match(/\/([1-4])季度\//)||[])[1];
    const starts={2:6,3:9,4:11},ranges={2:'6—8月',3:'9—10月',4:'11月至次年1月'};
    day=date(year,starts[q],1);target=folder(kind,day)+'/阶段计划（'+ranges[q]+'）.md';
    rec.placement='原自定义阶段跨自然季度，按起始月份归档，文件名保留实际范围，正文不改写。';
  }else throw Error('未识别笔记 '+rec.source);
  if(outputs.has(target)){
    assert(kind==='daily','周期笔记目标冲突 '+target);
    target=folder(kind,day)+'/'+base+'（早期版本）.md';kind='variant';
    assert(!outputs.has(target),'版本目标冲突 '+target);
  }
  return {status:'原样保留',kind,date:day,target};
}
for(const old of previous.records){
  const [name,...parts]=old.source.split('/'),relative=parts.join('/');
  const file=path.join(snapshot,'原始文件',old.source),bytes=fs.readFileSync(file);
  assert.equal(digest(bytes),old.hash,'原件副本校验失败 '+old.source);
  assert.equal(digest(fs.readFileSync(path.join(sources[name],relative))),old.hash,'源目录文件已发生变化 '+old.source);
  const rec={source:old.source,relative,sourceRoot:sources[name],sourceHash:old.hash,bytes};
  if(old.duplicateOf){rec.duplicateOf=old.duplicateOf;rec.status='完全重复，使用同一份原件';records.push(rec);continue;}
  Object.assign(rec,locate(rec));records.push(rec);
  if(rec.target){outputs.set(rec.target,rec);if(['daily','weekly','monthly','quarterly','yearly'].includes(rec.kind))routes[core.route(rec.kind,rec.date)]=rec.target;registerAlias(rec);}
}
for(const rec of records.filter(r=>r.duplicateOf)){
  const original=records.find(r=>r.source===rec.duplicateOf);assert(original);rec.target=original.target;rec.kind=original.kind;rec.date=original.date;
}
function resolve(target){
  const clean=target.replace(/\.md$/,'');
  if(outputs.has(clean+'.md'))return clean+'.md';
  const matches=aliases.get(clean)||aliases.get(path.posix.basename(clean));
  if(matches?.size===1)return [...matches][0];
  // A duplicate dated filename still resolves to its main version.
  const candidates=matches?[...matches].filter(p=>!p.includes('（早期版本）')):[];
  if(candidates.length===1)return candidates[0];
  const b=path.posix.basename(clean);let m;
  if(/^20\d{2}-\d{2}-\d{2}$/.test(b))return core.route('daily',b);
  if((m=b.match(/^(20\d{2})-W(\d{2})$/))){const jan4=core.date(+m[1],1,4);const d=core.iso(core.add(jan4,1-(jan4.getUTCDay()||7)+(+m[2]-1)*7));return routes[core.route('weekly',d)]||core.route('weekly',d);}
  if((m=b.match(/^(20\d{2})-M(\d{2})$/)))return routes[core.route('monthly',date(+m[1],+m[2],1))]||core.route('monthly',date(+m[1],+m[2],1));
  if((m=b.match(/^(20\d{2})-Q0?([1-4])$/)))return routes[core.route('quarterly',date(+m[1],(+m[2]-1)*3+1,1))]||core.route('quarterly',date(+m[1],(+m[2]-1)*3+1,1));
  if((m=b.match(/^(20\d{2})-Overview$/)))return routes[core.route('yearly',m[1]+'-01-01')]||core.route('yearly',m[1]+'-01-01');
  return null;
}
function rewriteLink(full){
  return full.replace(/(!?)\[\[([^\]]+)\]\]/g,(whole,embed,inside)=>{
    const [destination,...labels]=inside.split('|'),[target,...anchors]=destination.split('#');if(!target)return whole;
    const mapped=resolve(target);if(!mapped)return whole;
    let anchor=anchors.join('#');
    // References to a period absent in the old library should address the headings of a future new note.
    if(!outputs.has(mapped)&&anchor){
      if(/最高优先级/.test(anchor))anchor='本周重点';
      else if(/年度核心目标/.test(anchor))anchor='今年重点';
      else if(/核心目标/.test(anchor))anchor='本季重点';
    }
    const label=labels.length?'|'+labels.join('|'):path.posix.basename(mapped,'.md')!==path.posix.basename(target,'.md')?'|'+path.posix.basename(target,'.md'):'';
    return `${embed}[[${mapped.replace(/\.md$/,'')}${anchor?'#'+anchor:''}${label}]]`;
  });
}
for(const rec of outputs.values()){
  const text=rec.bytes.toString('utf8');let fence=null;
  const rewritten=text.split(/(?<=\n)/).map(line=>{
    const f=line.match(/^\s*(`{3,}|~{3,})/);
    if(f){fence=fence?(fence===f[1][0]?null:fence):f[1][0];return line;}
    return fence?line:rewriteLink(line);
  }).join('');
  // This exact transformation only substitutes wikilink destinations/aliases; all other bytes stay intact.
  rec.output=Buffer.from(rewritten,'utf8');rec.outputHash=digest(rec.output);
  const mask=s=>s.replace(/(!?)\[\[[^\]]+\]\]/g,'$1[[LINK]]');
  assert.equal(mask(rewritten),mask(text),'正文发生了非链接修改 '+rec.source);
}
const stale=previous.outputs.filter(o=>o.file.startsWith('01. Daily/')&&!outputs.has(o.file));
const index={version:1,routes,files:[...outputs.values()].map(r=>({path:r.target,kind:r.kind,date:r.date,source:r.source}))};
const summary={sourceNotes:records.length,duplicateCopies:records.filter(r=>r.duplicateOf).length,sourceOnlyNotes:records.filter(r=>r.status.startsWith('仅保留')).length,restoredFiles:outputs.size,kinds:Object.fromEntries([...new Set([...outputs.values()].map(r=>r.kind))].map(k=>[k,[...outputs.values()].filter(r=>r.kind===k).length])),obsoleteGeneratedNotes:stale.length,linkAdjustedFiles:[...outputs.values()].filter(r=>r.outputHash!==r.sourceHash).length};
console.log(JSON.stringify(summary,null,2));
if(!process.argv.includes('--apply'))process.exit(0);
assert(!fs.existsSync(backup),'恢复备份已经存在，停止重复操作');assert(!fs.existsSync(path.join(root,'.git')));
for(const old of previous.outputs.filter(o=>o.file.startsWith('01. Daily/'))){assert.equal(digest(fs.readFileSync(safe(old.file))),old.hash,'历史文件已有新修改，停止覆盖 '+old.file);}
for(const [file]of outputs)if(fs.existsSync(safe(file))&&!previous.outputs.some(o=>o.file===file))throw Error('目标文件已经存在 '+file);
fs.mkdirSync(backup,{recursive:true});
for(const old of previous.outputs){const from=safe(old.file);if(!fs.existsSync(from))continue;const dest=path.join(backup,'恢复前',old.file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(from,dest);}
const indexPath=path.join(root,'.obsidian/plugins/light-okr/legacy-notes.json');fs.writeFileSync(indexPath,JSON.stringify(index,null,2)+'\n','utf8');
for(const rec of outputs.values()){const target=safe(rec.target);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,rec.output);}
for(const old of stale){const target=safe(old.file);assert.equal(digest(fs.readFileSync(target)),old.hash);fs.unlinkSync(target);}
function removeEmpty(dir){assert(dir.startsWith(path.join(root,'01. Daily')+path.sep));for(const e of fs.readdirSync(dir,{withFileTypes:true}))if(e.isDirectory()&&!e.isSymbolicLink())removeEmpty(path.join(dir,e.name));if(!fs.readdirSync(dir).length)fs.rmdirSync(dir);}
for(const e of fs.readdirSync(path.join(root,'01. Daily'),{withFileTypes:true}))if(e.isDirectory()&&!e.isSymbolicLink())removeEmpty(path.join(root,'01. Daily',e.name));
const manifest={summary,records:records.map(({source,sourceHash,target,kind,date,status,duplicateOf,placement})=>({source,sourceHash,target,kind,date,status,duplicateOf,placement})),outputs:[...outputs.values()].map(r=>({file:r.target,kind:r.kind,date:r.date,source:r.source,sourceHash:r.sourceHash,outputHash:r.outputHash}))};
fs.writeFileSync(path.join(backup,'恢复清单.json'),JSON.stringify(manifest,null,2)+'\n','utf8');
for(const rec of outputs.values())assert.equal(digest(fs.readFileSync(safe(rec.target))),rec.outputHash);
console.log('PASS: originals restored; only internal wikilinks adjusted; superseded generated notes removed; current overall goals preserved.');
