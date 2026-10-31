import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  loadConfig,
  projectRoot,
  validateProductionSettings,
  qqConfiguration,
} from "./config.js";
import { passwordHash } from "./auth.js";
import { initializePrivateBackup, verifyGitHubPrivate } from "./git.js";
import { AppError } from "../../packages/contracts/types.js";
import { Store,restoreData } from "./store.js";
import { SnapshotBackup,backupKey,decryptBackup } from "./snapshot-backup.js";
import { recoveryInventory,releaseRecovery,type RecoveryScope } from "./recovery-control.js";
import { explainAutomation } from "../../packages/domain/automation-diagnostics.js";
import {approveRecoveryBudget} from "./model-budget.js";
async function main() {
  const command = process.argv[2],
    env = process.env;
  if (command === "password") {
    const terminal = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      process.stderr.write("输入仅用于本机生成哈希，请避免屏幕录制。\n");
      const password = await terminal.question("访问密码：");
      if (password.length < 12)
        throw new AppError("PASSWORD_TOO_SHORT", "请使用至少12个字符");
      console.log(passwordHash(password));
    } finally {
      terminal.close();
    }
    return;
  }
  const root = env.SECRETARY_VAULT_ROOT;
  if (
    !root ||
    !path.isAbsolute(root) ||
    !fs.existsSync(root) ||
    !fs.statSync(root).isDirectory()
  )
    throw new AppError("VAULT_REQUIRED", "需要已存在的独立数据目录");
  if (command === "init-backup") {
    if (!env.SECRETARY_GIT_REMOTE)
      throw new AppError("REMOTE_REQUIRED", "需要指定私有数据仓库");
    await initializePrivateBackup(root, env.SECRETARY_GIT_REMOTE, (remote) =>
      verifyGitHubPrivate(remote, env.SECRETARY_GITHUB_METADATA_TOKEN),
    );
    console.log(JSON.stringify({ initialized: true, pushed: false }));
    return;
  }
  if (command === "restore-data") {
    const file = process.argv[3];
    if (!file || fs.statSync(file).size > 96 * 1024 * 1024)
      throw new AppError("EXPORT_INVALID", "需要有效的导出文件，最大96MiB");
    let value=JSON.parse(fs.readFileSync(file,"utf8"));
    if(value.format==="secretary-encrypted-backup") {
      if(!env.SECRETARY_BACKUP_KEY_FILE)throw new AppError("BACKUP_KEY_REQUIRED","需要库外备份密钥文件");
      value=decryptBackup(value,backupKey(env.SECRETARY_BACKUP_KEY_FILE,root));
    }
    console.log(
      JSON.stringify(
        restoreData(root,value),
      ),
    );
    return;
  }
  if (command === "explain-automation") {
    // Reads the truth files directly: the running service owns the lock, and "why
    // did my reminder not fire" must be answerable without stopping it.
    const registryFile = path.join(root, ".agent/state/registry.json");
    const configFile = path.join(root, ".agent/config.json");
    if (!fs.existsSync(registryFile))
      throw new AppError("VAULT_INCOMPLETE", "这个目录里没有 registry.json", 400);
    const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    const config = fs.existsSync(configFile)
      ? JSON.parse(fs.readFileSync(configFile, "utf8"))
      : {};
    const quiet = config.notifications?.quiet_hours ?? { start: "23:00", end: "08:00" };
    const zone = config.timezone ?? "Asia/Shanghai";
    const now = new Date().toISOString();
    const rows = (registry.automations ?? []).map((automation: any) => ({
      title: automation.title,
      ...explainAutomation(automation, quiet, now, zone),
    }));
    console.log(JSON.stringify({ now, zone, quiet_hours: quiet, automations: rows }, null, 1));
    return;
  }
  if(command==="backup-data") {
    const store=new Store(root,loadConfig(root));
    try {
      const backup=new SnapshotBackup(store,env.SECRETARY_BACKUP_DIR,env.SECRETARY_BACKUP_KEY_FILE);
      await backup.tick(true);console.log(JSON.stringify(backup.status));
      if(backup.status.state!=="saved")process.exitCode=1;
    } finally {await store.close();}
    return;
  }
  if(command==="recovery-import-revocations") {
    const file=process.argv[3];
    if(!file || !fs.existsSync(file))throw new AppError("REVOCATION_LIST_REQUIRED","需要最新的撤销清单文件");
    const payload=JSON.parse(fs.readFileSync(file,"utf8"));
    const store=new Store(root,loadConfig(root));
    try{
      const result=store.importRevocations(payload);
      console.log(JSON.stringify({...result,revocation_history:store.runtimeMeta().revocation_history},null,2));
    } finally {await store.close();}
    return;
  }
  if(command==="recovery-check" || command==="recovery-release" || command==="recovery-budget") {
    const store=new Store(root,loadConfig(root));
    try {
      const result=command==="recovery-budget"?approveRecoveryBudget(store,Number(process.argv[3]),Number(process.argv[4]),process.argv[5]??""):
        command==="recovery-check"?recoveryInventory(store):releaseRecovery(store,process.argv[3]??"",
        (process.argv[4]??"").split(",") as RecoveryScope[],process.argv[5]??"");
      console.log(JSON.stringify(result,null,2));
    } finally {await store.close();}
    return;
  }
  if (command !== "preflight")
    throw new AppError(
      "UNKNOWN_COMMAND",
      "使用 preflight、password、init-backup、backup-data、restore-data <文件>、recovery-import-revocations <清单文件>、recovery-check 或 recovery-release <清单hash> <background_write,contact> reviewed-current-authority",
    );
  const cfg = loadConfig(root);
  validateProductionSettings({
    env,
    passwordHash: env.SECRETARY_WEB_PASSWORD_HASH ?? "",
    sessionKey: env.SECRETARY_SESSION_SIGNING_KEY ?? "",
    origin: env.SECRETARY_PUBLIC_ORIGIN,
  });
  fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
  const real = fs.realpathSync(root),
    code = fs.realpathSync(projectRoot);
  if (
    real === code ||
    real.startsWith(code + path.sep) ||
    code.startsWith(real + path.sep)
  )
    throw new AppError("CODE_DATA_OVERLAP", "生产服务代码与笔记数据需要分开");
  const checks = {
    vault: "passed",
    configuration: "passed",
    web:
      env.SECRETARY_WEB_ENABLED === "0"
        ? "disabled"
        : !!env.SECRETARY_WEB_PASSWORD_HASH &&
            !!env.SECRETARY_SESSION_SIGNING_KEY &&
            !!env.SECRETARY_PUBLIC_ORIGIN
          ? "configured"
          : "missing",
    astrbot:
      !!env.SECRETARY_ASTRBOT_URL && !!env.SECRETARY_BRIDGE_TOKEN
        ? "configured"
        : "missing",
    model:
      !!env.LLM_BASE_URL && !!env.LLM_MODEL && !!env.LLM_API_KEY
        ? "configured"
        : "missing",
    qq: qqConfiguration(env),
    git:
      env.SECRETARY_GIT_ENABLED === "1" &&
      !!env.SECRETARY_GIT_REMOTE &&
      !!env.SECRETARY_GITHUB_METADATA_TOKEN
        ? fs.existsSync(path.join(root, ".git"))
          ? "configured"
          : "needs_initialization"
        : "disabled_or_missing",
  };
  console.log(
    JSON.stringify(
      {
        checks,
        timezone: cfg.timezone,
        v1_configured: Object.values(checks).every((status) =>
          ["passed", "configured"].includes(status),
        ),
        external_connections_tested: false,
      },
      null,
      2,
    ),
  );
  if (checks.web === "missing") process.exitCode = 1;
  if (env.SECRETARY_WEB_ENABLED === "0" && checks.qq !== "configured") {
    // Without the web surface, QQ is the only way in and must be usable.
    console.error("QQ-only 部署需要已配置的 QQ 接入（SECRETARY_QQ_ENABLED=1 及配对信息）");
    process.exitCode = 1;
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      error: error instanceof AppError ? error.code : "PREFLIGHT_FAILED",
      message:
        error instanceof AppError
          ? error.message
          : "检查未完成，未输出凭据或堆栈",
    }),
  );
  process.exitCode = 1;
});
