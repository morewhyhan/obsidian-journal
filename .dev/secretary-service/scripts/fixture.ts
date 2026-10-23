import path from "node:path";
import fs from "node:fs";
import { atomicWrite } from "../apps/core/files.js";
import { createApp } from "../apps/core/app.js";
import { passwordHash } from "../apps/core/auth.js";
import { projectRoot } from "../apps/core/config.js";
import { git } from "../apps/core/git.js";
const port = Number(process.env.SECRETARY_DEMO_PORT ?? 3180);
const runtime = path.join(projectRoot, ".runtime");
fs.mkdirSync(runtime, { recursive: true });
const root =
  process.env.SECRETARY_FIXTURE_ISOLATED === "1"
    ? fs.mkdtempSync(path.join(runtime, "e2e-vault-" + port + "-"))
    : path.join(runtime, "demo-vault-" + port);
fs.mkdirSync(root, { recursive: true });
const empty = [
  ["README.md", "# 我的空间\n"],
  ["想做清单.md", "# 想做清单\n\n"],
  ["02. Decisions/关于选择.md", "# 关于选择\n\n先把问题写下来。\n"],
  [
    "03. Manual/开始一个小动作.md",
    "# 开始一个小动作\n\n把事情变小，留出开始的位置。\n",
  ],
];
for (const [p, content] of empty)
  if (!fs.existsSync(path.join(root, p)))
    atomicWrite(path.join(root, p), content);
const password = "local-demo-password",
  app = await createApp({
    vault: root,
    passwordHash: passwordHash(password),
    sessionKey: "local-demo-session-key-not-for-production",
    secure: false,
    origin: "http://127.0.0.1:" + port,
    timers: false,
    env: {},
  });
if (process.env.SECRETARY_FIXTURE_GIT === "1") {
  if (process.env.SECRETARY_FIXTURE_ISOLATED !== "1")
    throw new Error("Git fixture requires an isolated generated vault");
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Browser fixture"]);
  await git(root, ["config", "user.email", "fixture@example.invalid"]);
  await git(root, ["add", "--", ...empty.map(([p]) => p)]);
  await git(root, ["commit", "-m", "Initial fixture notes"]);
}
await app.app.listen({ host: "127.0.0.1", port });
console.log(
  "Isolated demo: http://127.0.0.1:" +
    port +
    " ; password: local-demo-password",
);
for (const s of ["SIGINT", "SIGTERM"] as const)
  process.on(s, () => void app.app.close());
