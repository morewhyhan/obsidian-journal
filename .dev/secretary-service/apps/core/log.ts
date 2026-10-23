import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import type { Store } from "./store.js";
/** Operational metadata only. Never accept arbitrary request/error objects. */
export class RuntimeLog {
  error: string | null = null;
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
        if (entry.name.slice(0, 10) < cutoff || bytes > 24 * 1024 * 1024) {
          fs.unlinkSync(entry.file);
          bytes -= entry.size;
        }
      this.error = null;
    } catch {
      this.error = "LOG_WRITE_FAILED";
    }
  }
}
