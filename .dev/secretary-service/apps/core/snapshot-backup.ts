import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DateTime } from "luxon";
import { AppError } from "../../packages/contracts/types.js";
import type { Store } from "./store.js";
import { atomicWrite,hash } from "./files.js";

const AAD=Buffer.from("secretary-backup:v1");
export function backupKey(file:string,vault?:string) {
  const keyPath=fs.realpathSync(file);
  if(vault && (keyPath===fs.realpathSync(vault) || keyPath.startsWith(fs.realpathSync(vault)+path.sep)))
    throw new AppError("BACKUP_KEY_IN_VAULT","备份密钥必须位于笔记库外",503);
  const raw=fs.readFileSync(keyPath),text=raw.toString("utf8").trim();
  const key=raw.length===32?raw:/^[a-f0-9]{64}$/i.test(text)?Buffer.from(text,"hex"):null;
  if(!key || key.length!==32)throw new AppError("BACKUP_KEY_INVALID","备份需要独立的32字节密钥",503);
  return key;
}
export function encryptBackup(value:unknown,key:Buffer) {
  const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",key,nonce);cipher.setAAD(AAD);
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),"utf8"),cipher.final()]);
  return {format:"secretary-encrypted-backup",version:1,key_id:hash(key).slice(7,23),nonce:nonce.toString("base64"),
    tag:cipher.getAuthTag().toString("base64"),ciphertext:ciphertext.toString("base64")};
}
export function decryptBackup(envelope:any,key:Buffer) {
  try {
    if(envelope?.format!=="secretary-encrypted-backup" || envelope.version!==1 || envelope.key_id!==hash(key).slice(7,23) ||
      typeof envelope.ciphertext!=="string" || envelope.ciphertext.length>100*1024*1024)throw new Error("format");
    const nonce=Buffer.from(envelope.nonce,"base64"),tag=Buffer.from(envelope.tag,"base64");
    if(nonce.length!==12||tag.length!==16)throw new Error("header");
    const decipher=crypto.createDecipheriv("aes-256-gcm",key,nonce);decipher.setAAD(AAD);decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,"base64")),decipher.final()]).toString("utf8"));
  }catch{throw new AppError("BACKUP_AUTHENTICATION_FAILED","备份认证或解密失败，未写入目标",400);}
}
export class SnapshotBackup {
  private busy=false;
  status:{state:string;last_success?:string;file?:string;error?:string}={state:"backup_unconfigured"};
  constructor(private s:Store,private directory?:string,private keyFile?:string) {
    if(directory && keyFile)this.status={state:"configured_not_verified"};
  }
  async tick(force=false) {
    if(this.busy || !this.directory || !this.keyFile)return;
    if(!this.s.time.read().trusted) {this.status={...this.status,state:"waiting",error:"TIME_SYNC_UNVERIFIED"};return;}
    const job=this.s.runtimeMeta().model_job;
    if(!["ready","degraded"].includes(this.s.lifecycle) || job?.generation===this.s.generation && job.deadline_at>this.s.now()) {
      this.status={...this.status,state:"waiting",error:"ACTIVE_MODEL_JOB"};return;
    }
    const local=DateTime.fromJSDate(this.s.clock(),{zone:this.s.config.timezone});
    const marker=this.s.runtimeMeta().backup_last_success;
    if(!force && (local.toFormat("HH:mm")<"04:00" || marker && DateTime.fromISO(marker).setZone(this.s.config.timezone).toISODate()===local.toISODate()))return;
    this.busy=true;
    let stage:string|undefined,stageParent:string|undefined;
    try {
      const output=path.resolve(this.directory),vault=fs.realpathSync(this.s.root),key=backupKey(this.keyFile,vault);
      fs.mkdirSync(output,{recursive:true,mode:0o700});
      const real=fs.realpathSync(output);
      if(real===vault || real.startsWith(vault+path.sep))throw new AppError("BACKUP_IN_VAULT","一致备份需要独立目录",503);
      stageParent=real;stage=fs.mkdtempSync(path.join(real,".snapshot-"));fs.chmodSync(stage,0o700);
      await this.s.exclusive(()=>{
        const current=this.s.runtimeMeta().model_job;
        if(!["ready","degraded"].includes(this.s.lifecycle) || current?.generation===this.s.generation && current.deadline_at>this.s.now())
          throw new AppError("BACKUP_BUSY","等待模型作业排空后再取得一致快照",409);
        const prior=this.s.lifecycle;this.s.lifecycle="maintenance";
        try {
          this.s.recover();
          const data=this.s.exportData();
          atomicWrite(path.join(stage!,"snapshot.json"),JSON.stringify({...data,business_revision:this.s.registry().revision}));
        }finally{this.s.lifecycle=prior;}
      });
      const snapshot=JSON.parse(fs.readFileSync(path.join(stage,"snapshot.json"),"utf8"));
      for(const entry of snapshot.files)if(hash(Buffer.from(entry.content,entry.encoding))!==entry.hash)
        throw new AppError("BACKUP_INTEGRITY_FAILED","备份暂存校验失败",503);
      const encrypted=encryptBackup(snapshot,key),name="secretary-"+this.s.now().replace(/[:.]/g,"-")+".enc.json";
      atomicWrite(path.join(real,name),JSON.stringify(encrypted));
      this.s.updateRuntimeMeta(m=>({...m,backup_last_success:this.s.now()}));
      this.status={state:"saved",last_success:this.s.now(),file:name};
      // Bound daily snapshots without touching unrelated files or incomplete stages.
      const files=fs.readdirSync(real).filter(x=>/^secretary-\d{4}-\d{2}-\d{2}T[\dTZ-]+\.enc\.json$/.test(x)).sort().reverse();
      for(const entry of files.slice(30)) {
        const full=path.join(real,entry),stat=fs.lstatSync(full);
        if(stat.isFile() && stat.nlink===1)fs.unlinkSync(full);
      }
    }catch(error){this.status={...this.status,state:"failed",error:error instanceof AppError?error.code:"BACKUP_FAILED"};}
    finally {
      if(stage && stageParent && path.dirname(path.resolve(stage))===stageParent && path.basename(stage).startsWith(".snapshot-") && fs.existsSync(stage))
        fs.rmSync(stage,{recursive:true,force:true});
      this.busy=false;
    }
  }
}
