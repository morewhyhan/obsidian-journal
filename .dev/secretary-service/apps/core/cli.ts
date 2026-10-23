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
  if (command !== "preflight")
    throw new AppError(
      "UNKNOWN_COMMAND",
      "使用 preflight、password 或 init-backup",
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
      !!env.SECRETARY_WEB_PASSWORD_HASH &&
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
