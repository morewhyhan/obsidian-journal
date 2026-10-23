import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// Runs only generated fixtures. Never accepts an existing vault, volume or container.
const exec = promisify(execFile),
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = crypto.randomUUID().replaceAll("-", ""),
  prefix = "secretary-check-" + runId;
const names = {
  network: prefix + "-net",
  volume: prefix + "-vault",
  tls: prefix + "-tls",
  core: prefix + "-core",
  pi: prefix + "-pi",
  caddy: prefix + "-caddy",
};
const image =
  process.env.SECRETARY_TEST_IMAGE ?? "private-secretary:verification";
const nodeImage = process.env.NODE_IMAGE ?? "node:24-bookworm-slim",
  caddyImage = process.env.CADDY_IMAGE ?? "caddy:2-alpine";
const report = {
  at: new Date().toISOString(),
  status: "running",
  scope: "generated fixtures; no real model, QQ, GitHub or public domain",
  steps: [],
  error: null,
};
const local = fs.mkdtempSync(
  path.join(os.tmpdir(), "secretary-container-check-"),
);
const ownedContainers = new Set(),
  ownedVolumes = new Set();
let networkCreated = false,
  stage = "docker_engine";
const docker = async (args, timeout = 45000) =>
  (
    await exec("docker", args, {
      cwd: root,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    })
  ).stdout;
const check = (condition) => {
  if (!condition) throw new Error("VERIFICATION_FAILED");
};
async function step(name, work) {
  stage = name;
  await work();
  report.steps.push({ id: name, status: "passed" });
  console.log("Verified: " + name);
}
async function waitReady() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await docker(
        [
          "exec",
          names.core,
          "node",
          "-e",
          "fetch('http://127.0.0.1:3180/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ],
        8000,
      );
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("CORE_NOT_READY");
}
const inside = async (container, source) =>
  JSON.parse(await docker(["exec", container, "node", "-e", source]));
const token = crypto.randomBytes(32).toString("hex"),
  session = crypto.randomBytes(32).toString("hex"),
  password = "container-fixture-only";
const salt = crypto.randomBytes(16).toString("hex"),
  passwordHash =
    "scrypt$" +
    salt +
    "$" +
    crypto
      .scryptSync(password, salt, 64, {
        N: 32768,
        r: 8,
        p: 1,
        maxmem: 128 * 1024 * 1024,
      })
      .toString("hex");
try {
  await step("docker_engine", async () => {
    await docker(["version", "--format", "{{.Server.Version}}"], 10000);
  });
  await step("build_runtime_image", async () => {
    await docker(
      [
        "build",
        "--build-arg",
        "NODE_IMAGE=" + nodeImage,
        "-f",
        "deploy/Dockerfile",
        "-t",
        image,
        ".",
      ],
      600000,
    );
  });
  await step("create_isolated_fixtures", async () => {
    await docker([
      "network",
      "create",
      "--internal",
      "--subnet",
      "10.84.0.0/24",
      "--label",
      "secretary.validation=" + runId,
      names.network,
    ]);
    networkCreated = true;
    for (const volume of [names.volume, names.tls]) {
      await docker([
        "volume",
        "create",
        "--label",
        "secretary.validation=" + runId,
        volume,
      ]);
      ownedVolumes.add(volume);
    }
    await docker([
      "run",
      "--rm",
      "--user",
      "0",
      "--mount",
      "type=volume,src=" + names.volume + ",dst=/vault",
      image,
      "node",
      "-e",
      "require('node:fs').chownSync('/vault',1000,1000)",
    ]);
    const common = [
      "--network",
      names.network,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--tmpfs",
      "/tmp:rw,size=64m,mode=1777",
      "--memory",
      "512m",
      "--cpus",
      "1",
      "--user",
      "1000:1000",
      "--label",
      "secretary.validation=" + runId,
    ];
    await docker([
      "run",
      "-d",
      "--name",
      names.core,
      ...common,
      "--network-alias",
      "core",
      "--ip",
      "10.84.0.2",
      "--mount",
      "type=volume,src=" + names.volume + ",dst=/vault",
      "-e",
      "NODE_ENV=production",
      "-e",
      "SECRETARY_HOST=0.0.0.0",
      "-e",
      "SECRETARY_VAULT_ROOT=/vault",
      "-e",
      "SECRETARY_PUBLIC_ORIGIN=https://localhost",
      "-e",
      "SECRETARY_WEB_PASSWORD_HASH=" + passwordHash,
      "-e",
      "SECRETARY_SESSION_SIGNING_KEY=" + session,
      "-e",
      "SECRETARY_PI_URL=http://pi:3181",
      "-e",
      "SECRETARY_PI_INTERNAL_TOKEN=" + token,
      "-e",
      "SECRETARY_TRUSTED_PROXY_IP=10.84.0.4",
      "-e",
      "LLM_MODEL=fixture-model",
      image,
    ]);
    ownedContainers.add(names.core);
    await docker([
      "run",
      "-d",
      "--name",
      names.pi,
      ...common,
      "--network-alias",
      "pi",
      "--ip",
      "10.84.0.3",
      "-e",
      "SECRETARY_PI_INTERNAL_TOKEN=" + token,
      "-e",
      "SECRETARY_CORE_MODEL_URL=http://core:3180/internal/model/v1",
      "-e",
      "LLM_MODEL=fixture-model",
      "-e",
      "HOME=/tmp",
      image,
      "node",
      "dist/server/apps/pi-adapter/main.js",
    ]);
    ownedContainers.add(names.pi);
    await waitReady();
  });
  await step("pi_permissions_and_network", async () => {
    const info = JSON.parse(await docker(["inspect", names.pi]))[0],
      network = JSON.parse(
        await docker(["network", "inspect", names.network]),
      )[0];
    check(
      info.HostConfig.ReadonlyRootfs &&
        info.HostConfig.CapDrop.includes("ALL") &&
        info.HostConfig.SecurityOpt.some((x) =>
          x.startsWith("no-new-privileges"),
        ),
    );
    check(
      info.Config.User === "1000:1000" &&
        network.Internal &&
        info.Mounts.every(
          (m) =>
            m.Destination !== "/vault" &&
            !m.Destination.startsWith("/run/secrets"),
        ) &&
        Object.keys(info.NetworkSettings.Networks).length === 1,
    );
    const permissions = await inside(
      names.pi,
      "const fs=require('node:fs'); console.log(JSON.stringify({vault:fs.existsSync('/vault'),provider:!!process.env.LLM_API_KEY,qq:!!process.env.QQ_ACCESS_TOKEN,git:!!process.env.GIT_SSH_COMMAND}));",
    );
    check(!Object.values(permissions).some(Boolean));
    await docker([
      "exec",
      names.pi,
      "node",
      "-e",
      "fetch('http://core:3180/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
    ]);
    await docker([
      "exec",
      names.pi,
      "node",
      "-e",
      "fetch('https://example.com',{signal:AbortSignal.timeout(2000)}).then(()=>process.exit(1)).catch(()=>process.exit(0))",
    ]);
    const denied = await inside(
      names.pi,
      "fetch('http://core:3180/api/v1/tree',{headers:{Authorization:'Bearer '+process.env.SECRETARY_PI_INTERNAL_TOKEN}}).then(r=>console.log(JSON.stringify({status:r.status})))",
    );
    check(denied.status === 401);
  });
  await step("caddy_and_fixture_https", async () => {
    await docker(["pull", caddyImage], 300000);
    await docker([
      "run",
      "-d",
      "--name",
      names.caddy,
      "--network",
      names.network,
      "--network-alias",
      "caddy",
      "--ip",
      "10.84.0.4",
      "--label",
      "secretary.validation=" + runId,
      "--mount",
      "type=bind,src=" +
        path.join(root, "deploy/Caddyfile") +
        ",dst=/etc/caddy/Caddyfile,readonly",
      "--mount",
      "type=volume,src=" + names.tls + ",dst=/data",
      "-e",
      "SECRETARY_DOMAIN=localhost",
      "-e",
      "SECRETARY_CORE_UPSTREAM=core:3180",
      caddyImage,
    ]);
    ownedContainers.add(names.caddy);
    let copied = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await docker([
          "cp",
          names.caddy + ":/data/caddy/pki/authorities/local/root.crt",
          path.join(local, "root.crt"),
        ]);
        copied = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    check(copied);
    await docker([
      "cp",
      path.join(local, "root.crt"),
      names.core + ":/tmp/fixture-ca.crt",
    ]);
    const probe = await inside(
      names.core,
      "const https=require('node:https'),fs=require('node:fs');const call=p=>new Promise((resolve,reject)=>https.get({hostname:'caddy',servername:'localhost',headers:{Host:'localhost'},path:p,ca:fs.readFileSync('/tmp/fixture-ca.crt')},r=>{r.resume();r.on('end',()=>resolve({status:r.statusCode,csp:!!r.headers['content-security-policy']}));}).on('error',reject));(async()=>console.log(JSON.stringify({home:await call('/'),private:await call('/internal/model/v1/chat/completions'),notes:await call('/api/v1/tree')})))();",
    );
    check(
      probe.home.status === 200 &&
        probe.home.csp &&
        probe.private.status === 404 &&
        probe.notes.status === 401,
    );
  });
  await step("write_and_restart", async () => {
    const create = await inside(
      names.core,
      "(async()=>{const base='http://127.0.0.1:3180',origin='https://localhost';const login=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password:'container-fixture-only'})});if(!login.ok)throw Error('login');const cookie=login.headers.get('set-cookie').split(';')[0],headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json','Idempotency-Key':'container-note'};const save=await fetch(base+'/api/v1/documents',{method:'POST',headers,body:JSON.stringify({path:'03. Manual/container.md',content:'# Exact fixture\\n\\n原文\\r\\n'})});const habit=await fetch(base+'/api/v1/commands',{method:'POST',headers:{...headers,'Idempotency-Key':'container-habit'},body:JSON.stringify({type:'create_habit',title:'隔离习惯',min_behavior:'读一句',recurrence:{weekdays:[1,2,3,4,5,6,7],starts_on:'2026-01-01'},anchor:{kind:'time_window',local_start:'20:00',local_end:'21:00'}})});console.log(JSON.stringify({save:save.status,habit:habit.status}));})();",
    );
    check(create.save === 200 && create.habit === 200);
    await docker(["restart", "--time", "45", names.core], 60000);
    await waitReady();
    const saved = await inside(
      names.core,
      "const fs=require('node:fs'); console.log(JSON.stringify({body:fs.readFileSync('/vault/03. Manual/container.md','utf8'),habits:JSON.parse(fs.readFileSync('/vault/.agent/state/registry.json')).habits.length}));",
    );
    check(saved.body === "# Exact fixture\n\n原文\r\n" && saved.habits === 1);
    await docker(["kill", "--signal", "KILL", names.core]);
    await new Promise((resolve) => setTimeout(resolve, 16000));
    await docker(["start", names.core]);
    await waitReady();
    const recovered = await inside(
      names.core,
      "const fs=require('node:fs'); console.log(JSON.stringify({body:fs.readFileSync('/vault/03. Manual/container.md','utf8'),habits:JSON.parse(fs.readFileSync('/vault/.agent/state/registry.json')).habits.length}));",
    );
    check(recovered.body === saved.body && recovered.habits === 1);
  });
  report.status = "passed";
  report.image_id = (
    await docker(["image", "inspect", "--format", "{{.Id}}", image])
  ).trim();
  report.node = await inside(
    names.core,
    "console.log(JSON.stringify(process.version))",
  );
  report.production_public_tls_tested = false;
} catch (error) {
  report.status = stage === "docker_engine" ? "blocked" : "failed";
  report.error = {
    stage,
    code:
      stage === "docker_engine"
        ? "DOCKER_ENGINE_UNAVAILABLE"
        : "CONTAINER_CHECK_FAILED",
  };
  process.exitCode = 1;
} finally {
  for (const container of [...ownedContainers].reverse())
    await docker(["rm", "--force", container]).catch(() => {});
  for (const volume of ownedVolumes)
    await docker(["volume", "rm", volume]).catch(() => {});
  if (networkCreated)
    await docker(["network", "rm", names.network]).catch(() => {});
  const relative = path.relative(os.tmpdir(), local);
  if (
    !relative.startsWith("secretary-container-check-") ||
    relative.includes(path.sep)
  )
    throw new Error("Unsafe temporary path");
  fs.rmSync(local, { recursive: true, force: true });
  const evidence = path.join(root, "docs/evidence");
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(
    path.join(evidence, "containers.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
