import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createApp } from "../apps/core/app.js";
import { passwordHash } from "../apps/core/auth.js";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "secretary-performance-"));
const files = 5000,
  totalBytes = 100 * 1024 * 1024,
  baseSize = Math.floor(totalBytes / files),
  remainder = totalBytes % files;
let instance: Awaited<ReturnType<typeof createApp>> | undefined;
try {
  fs.mkdirSync(path.join(root, "03. Manual/performance"), { recursive: true });
  for (let i = 0; i < files; i++) {
    const prefix = "# Fixture " + i + "\n\nneedle-first-probe " + i + "\n";
    const bytes = baseSize + (i < remainder ? 1 : 0);
    fs.writeFileSync(
      path.join(root, "03. Manual/performance/" + i + ".md"),
      prefix + "x".repeat(bytes - Buffer.byteLength(prefix)),
    );
  }
  instance = await createApp({
    vault: root,
    passwordHash: passwordHash("fixture-performance"),
    sessionKey: "fixture-performance",
    origin: "http://localhost",
    secure: false,
    timers: false,
    env: {},
  });
  const login = await instance.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin: "http://localhost" },
    payload: { password: "fixture-performance" },
  });
  if (login.statusCode !== 200) throw new Error("Fixture login failed");
  const cookie = login.cookies[0].name + "=" + login.cookies[0].value,
    headers = { cookie, origin: "http://localhost" };
  const searchStart = performance.now(),
    search = await instance.app.inject({
      url: "/api/v1/search?q=needle-first-probe",
      headers,
    });
  const firstSearch = performance.now() - searchStart;
  if (search.statusCode !== 200 || search.json().total !== files)
    throw new Error("Incomplete search");
  const reads: number[] = [],
    saves: number[] = [];
  for (let i = 0; i < 100; i++) {
    const relative = "03. Manual/performance/" + ((i * 47) % files) + ".md";
    let start = performance.now();
    const read = await instance.app.inject({
      url: "/api/v1/documents?path=" + encodeURIComponent(relative),
      headers,
    });
    reads.push(performance.now() - start);
    if (read.statusCode !== 200) throw new Error("Read failed");
    const doc = read.json();
    start = performance.now();
    const save = await instance.app.inject({
      method: "PUT",
      url: "/api/v1/documents",
      headers: { ...headers, "idempotency-key": "perf-save-" + i },
      payload: {
        path: relative,
        base_hash: doc.hash,
        content: doc.content + "\n",
      },
    });
    saves.push(performance.now() - start);
    if (save.statusCode !== 200) throw new Error("Save failed");
  }
  const p95 = (samples: number[]) =>
    [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1];
  const cgroup =
    process.platform === "linux"
      ? fs
          .readFileSync("/proc/self/cgroup", "utf8")
          .split("\n")
          .find((line) => line.startsWith("0::"))
          ?.slice(3)
      : null;
  const cgroupRoot = cgroup
    ? path.join("/sys/fs/cgroup", cgroup)
    : "/sys/fs/cgroup";
  const readLimit = (name: string) =>
    fs.existsSync(path.join(cgroupRoot, name))
      ? fs.readFileSync(path.join(cgroupRoot, name), "utf8").trim()
      : null;
  const facts = {
    at: new Date().toISOString(),
    platform: process.platform,
    release: os.release(),
    node: process.version,
    cpus_visible: os.availableParallelism(),
    configured_memory_max: readLimit("memory.max"),
    configured_cpu_max: readLimit("cpu.max"),
    files,
    total_markdown_bytes: totalBytes,
    samples: 100,
    first_search_ms: firstSearch,
    read_p95_ms: p95(reads),
    save_p95_ms: p95(saves),
    max_rss_kib: process.resourceUsage().maxRSS,
    passed: firstSearch < 2000 && p95(reads) < 500 && p95(saves) < 500,
  };
  console.log(JSON.stringify(facts, null, 2));
  if (process.env.SECRETARY_PERFORMANCE_REPORT)
    fs.writeFileSync(
      process.env.SECRETARY_PERFORMANCE_REPORT,
      JSON.stringify(facts, null, 2) + "\n",
    );
  if (!facts.passed) process.exitCode = 1;
} finally {
  await instance?.app.close();
  const relative = path.relative(os.tmpdir(), root);
  if (
    !relative.startsWith("secretary-performance-") ||
    relative.includes(path.sep)
  )
    throw new Error("Unsafe cleanup");
  fs.rmSync(root, { recursive: true, force: true });
}
