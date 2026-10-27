import type { Registry } from "../../packages/contracts/types.js";
import { AppError } from "../../packages/contracts/types.js";
import type { Store } from "./store.js";
import { canonicalJson,hash } from "./files.js";
import {localDate} from "../../packages/calendar/index.js";
import fs from "node:fs";

type Query={operation:string;scope?:string;query?:string;ids?:string[];date?:string;offset?:number};
type Stamp={key:string;query?:Query;path?:string;resource?:{operation:"list"|"search";prefix:string};digest:string};
const queries=["state","followups","rules","planning","planning_context","preferences","automations","focus","board","day"];
function select(r:Registry,q:Query) {
  const scopes=q.scope && q.scope!=="all"?[q.scope]:["tasks","habits","plans","controls","proposals"];
  let all:any[]=q.operation==="followups" ? r.followups??[] : q.operation==="rules"?r.user_rules??[]:
    scopes.flatMap(k=>(r as any)[k]??[]);
  return all.filter(x=>(!q.ids?.length || q.ids.includes(x.id) || q.ids.includes(x.issue?.task_id??x.issue?.habit_id)) &&
    (!q.query || JSON.stringify(x).toLocaleLowerCase().includes(q.query.toLocaleLowerCase())))
    .sort((a,b)=>a.id.localeCompare(b.id));
}
function digest(s:Store,r:Registry,stamp:Stamp) {
  if(stamp.resource) {
    const {prefix,operation}=stamp.resource;
    const files=s.files.list().filter(p=>!prefix || p===prefix || p.startsWith(prefix+"/"));
    if(fs.existsSync(s.files.resolve(".agent/context/memory.md")))files.push(".agent/context/memory.md");
    const roots=fs.readdirSync(s.files.root,{withFileTypes:true}).filter(x=>x.isDirectory()&&!x.isSymbolicLink()&&!x.name.startsWith(".")).map(x=>x.name);
    return hash(canonicalJson({roots:roots.sort(),files:files.map(p=>{
      if(operation==="list")return p;
      const stat=fs.lstatSync(s.files.resolve(p));return [p,stat.size,stat.mtimeMs,stat.ctimeMs,stat.ino];
    })}));
  }
  if(stamp.path)try{return hash(s.files.read(stamp.path));}catch{return "missing";}
  const q=stamp.query!;
  if(q.operation==="day")return hash(canonicalJson(s.day(q.date!)));
  if(!["state","followups","rules"].includes(q.operation))return hash(canonicalJson({
    tasks:r.tasks,habits:r.habits,plans:r.plans,controls:r.controls,proposals:r.proposals,
    rules:r.user_rules??[],automations:r.automations??[],followups:r.followups??[],focus:r.focus_date,
    planning:r.planning_preferences,rules_revision:r.rules_revision??0,planning_version:r.planning_version??0,day:s.day(q.date!)}));
  return hash(canonicalJson(select(r,stamp.query!)));
}
function metadata(s:Store,input:string){const row=s.db.prepare("SELECT metadata_json FROM inbox WHERE id=?").get(input) as any;return row?JSON.parse(row.metadata_json):null;}
function save(s:Store,input:string,stamps:Stamp[]) {
  if(stamps.length>64)throw new AppError("READ_SET_LIMIT","读取集合已达上限，请保存责任后用新回合接续",409);
  s.db.prepare("UPDATE inbox SET metadata_json=json_set(metadata_json,'$.read_stamps',json(?)) WHERE id=?").run(JSON.stringify(stamps),input);
}
export function queryStamp(s:Store,args:Query,snapshot:Registry):Stamp|undefined {
  if(!queries.includes(args.operation))return;
  const {offset,...query}=args;const normalized:Query={operation:query.operation,
    ...(query.scope?{scope:query.scope}:{}),...(query.query?{query:query.query}:{}),...(query.ids?{ids:[...query.ids].sort()}: {}),
    ...(!["state","followups","rules"].includes(query.operation)?{date:query.date??localDate(s.clock(),s.config.timezone)}:{})};
  const stamp:Stamp={key:hash(canonicalJson(normalized)),query:normalized,digest:""};stamp.digest=digest(s,snapshot,stamp);return stamp;
}
export function recordQuery(s:Store,input:string,args:Query,snapshot:Registry,captured?:Stamp) {
  const stamp=captured??queryStamp(s,args,snapshot);if(!stamp)return;
  const meta=metadata(s,input);if(!meta)return;
  const all:Stamp[]=meta.read_stamps??[],prior=all.find(x=>x.key===stamp.key);
  if(args.offset && prior && prior.digest!==stamp.digest)throw new AppError("QUERY_SNAPSHOT_CHANGED","分页数据已经变化，请从第一页重读",409);
  save(s,input,[...all.filter(x=>x.key!==stamp.key),stamp]);
}
export function recordNote(s:Store,input:string,path:string,contentHash:string) {
  const meta=metadata(s,input);if(!meta)return;
  const all:Stamp[]=meta.read_stamps??[],key="note:"+path;
  save(s,input,[...all.filter(x=>x.key!==key),{key,path,digest:contentHash}]);
}
export function workspaceStamp(s:Store,operation:"list"|"search",prefix="") {
  const resource={operation,prefix:prefix==="."?"":prefix.replace(/\/$/,"")},stamp:Stamp={key:"workspace:"+hash(canonicalJson(resource)),resource,digest:""};
  stamp.digest=digest(s,s.registry(),stamp);return stamp;
}
export function recordWorkspace(s:Store,input:string,stamp:Stamp,offset=0) {
  const meta=metadata(s,input);if(!meta)return;const all:Stamp[]=meta.read_stamps??[],prior=all.find(x=>x.key===stamp.key);
  if(offset && prior && prior.digest!==stamp.digest)throw new AppError("QUERY_SNAPSHOT_CHANGED","目录或搜索范围已经变化，请从第一页重读",409);
  save(s,input,[...all.filter(x=>x.key!==stamp.key),stamp]);
}
export function checkReads(s:Store,input:string) {
  const all:Stamp[]=metadata(s,input)?.read_stamps??[],r=s.registry();
  for(const stamp of all)if(stamp.digest!==digest(s,r,stamp))throw new AppError("VERSION_CONFLICT","实际读取的对象、集合或文件已经变化，请重读相关资料",409);
}
/** Only call inside the same writer turn after all stamps were checked and this operation applied. */
export function advanceOwnReads(s:Store,input:string) {
  const all:Stamp[]=metadata(s,input)?.read_stamps??[],r=s.registry();
  save(s,input,all.map(stamp=>stamp.path?stamp:{...stamp,digest:digest(s,r,stamp)}));
}
