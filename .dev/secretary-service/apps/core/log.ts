import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import type { Store } from "./store.js";
/** Operational metadata only. Never accept arbitrary request/error objects. */
export class RuntimeLog {
  error: string | null = null;
  private errors=new Map<string,{module:string;code:string;first_seen:string;last_seen:string;count:number}>();
  private durations=[0,0,0,0,0,0];
  private readonly bounds=[10,50,250,1000,10000];
  private overflow=0;
  summary() {return {state:this.error?"diagnostic_degraded":"ready",error:this.error,
    errors:[...this.errors.values()],error_groups_dropped:this.overflow,
    latency:{bounds_ms:this.bounds,counts:[...this.durations],last_bucket:"above_10000_ms"}};}
  constructor(private store: Store) {}
  write(
    event: string,
    fields: {
      request_id?: string;
      operation_id?: string;
      code?: string;
      status?: number;
      duration_ms?: number;
      route?: string;
    } = {},
  ) {
    const safe=(value:string)=>value.replace(/[^A-Za-z0-9_:\-./]/g,"").slice(0,120);
    if(fields.code) {
      const module=safe(event),code=safe(fields.code),key=module+":"+code,now=this.store.now(),prior=this.errors.get(key);
      if(prior){prior.last_seen=now;prior.count++;}
      else if(this.errors.size<128)this.errors.set(key,{module,code,first_seen:now,last_seen:now,count:1});
      else this.overflow++;
    }
    if(Number.isFinite(fields.duration_ms) && fields.duration_ms!>=0) {
      const bucket=this.bounds.findIndex(x=>fields.duration_ms!<=x);this.durations[bucket<0?5:bucket]++;
    }
    try {
      const date = DateTime.fromJSDate(this.store.clock(), {
          zone: this.store.config.timezone,
        }).toISODate()!,
        root = this.store.files.resolve(".agent/data/logs", "internal");
      fs.mkdirSync(root, { recursive: true });
      const short = (value: string | undefined) =>
        value?.replace(/[^A-Za-z0-9_:\-./]/g, "").slice(0, 120);
      const line =
        JSON.stringify({
          at: this.store.now(),
          event: short(event),
          request_id: short(fields.request_id),
          operation_id: short(fields.operation_id),
          code: short(fields.code),
          status: fields.status,
          duration_ms:
            fields.duration_ms === undefined
              ? undefined
              : Math.round(fields.duration_ms),
          route: short(fields.route),
        }) + "\n";
      let number = 0,
        file = path.join(root, date + ".0.log");
      while (
        fs.existsSync(file) &&
        fs.statSync(file).size + Buffer.byteLength(line) > 10 * 1024 * 1024
      ) {
        number++;
        file = path.join(root, date + "." + number + ".log");
      }
      fs.appendFileSync(file, line, { mode: 0o600 });
      const cutoff = DateTime.fromISO(date).minus({ days: 6 }).toISODate()!,
        entries = fs
          .readdirSync(root)
          .filter((name) => /^\d{4}-\d{2}-\d{2}\.\d+\.log$/.test(name))
          .map((name) => ({
            name,
            file: this.store.files.resolve(
              ".agent/data/logs/" + name,
              "internal",
            ),
            size: fs.lstatSync(
              this.store.files.resolve(".agent/data/logs/" + name, "internal"),
            ).size,
          }))
          .sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { numeric: true }),
          );
      let bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
      for (const entry of entries)
        if (entry.name.slice(0, 10) < cutoff || bytes > 50 * 1024 * 1024) {
          fs.unlinkSync(entry.file);
          bytes -= entry.size;
        }
      this.error = null;
    } catch {
      this.error = "LOG_WRITE_FAILED";
    }
  }
}
