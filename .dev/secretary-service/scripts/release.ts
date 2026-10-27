import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {projectRoot,resource} from "../apps/core/config.js";
import {atomicWrite,canonicalJson,hash} from "../apps/core/files.js";
import {AGENT_TOOLS} from "../packages/contracts/agent-tools.js";

const files:{path:string;hash:string}[]=[];
function visit(relative:string) {
  for(const entry of fs.readdirSync(path.join(projectRoot,relative),{withFileTypes:true})) {
    if(entry.isSymbolicLink() || entry.name==="__pycache__")continue;
    const name=path.posix.join(relative,entry.name);
    if(entry.isDirectory())visit(name);
    else if(/\.(ts|tsx|py|json|sql|md|yaml|sh)$/.test(name) && name!=="resources/release.json")
      files.push({path:name,hash:hash(fs.readFileSync(path.join(projectRoot,name)))});
  }
}
for(const directory of ["apps","packages","integrations","resources","deploy","scripts"])visit(directory);
// Code-point order, not locale collation: ICU collation differs between the
// Windows dev host and the Linux build image for CJK filenames, which would
// change source_hash for identical bytes.
files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
const git=spawnSync("git",["rev-parse","HEAD"],{cwd:projectRoot,encoding:"utf8",windowsHide:true});
const commit=/^[a-f0-9]{40,64}$/.test(git.stdout?.trim()??"")?git.stdout.trim():null;
const pkg=JSON.parse(fs.readFileSync(path.join(projectRoot,"package.json"),"utf8"));
const manifest={format:1,service_version:pkg.version,source_commit:commit,source_commit_is_base_only:true,source_hash:hash(canonicalJson(files)),
  lock_hash:hash(fs.readFileSync(path.join(projectRoot,"package-lock.json"))),tools_hash:hash(canonicalJson(AGENT_TOOLS)),
  plugin_version:"1.0.0",registry_schema:2,days_schema:1,sql_schema:1,calendar_engine:"light-okr-v1",
  image_digests:"verified-at-deployment",files};
atomicWrite(resource("release.json"),JSON.stringify(manifest,null,2)+"\n");
// The manifest ships inside the image and the evaluation runner reads it as a
// non-owner user; atomicWrite keeps vault data at 0600, which would hide it.
fs.chmodSync(resource("release.json"),0o644);
console.log(JSON.stringify({source_commit:commit,source_hash:manifest.source_hash,files:files.length}));
