import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../apps/core/app.js";
import { passwordHash } from "../apps/core/auth.js";
import { projectRoot } from "../apps/core/config.js";
import {
  actionSchema,
  proposalSchema,
  criterionSchema,
  noteRefSchema,
} from "../packages/contracts/api.js";
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "secretary-contract-"));
let instance: Awaited<ReturnType<typeof createApp>> | undefined;
try {
  instance = await createApp({
    vault: temporary,
    passwordHash: passwordHash("fixture-only"),
    sessionKey: "fixture-only",
    timers: false,
    env: {},
  });
  await instance.app.ready();
  fs.writeFileSync(
    path.join(projectRoot, "packages/contracts/openapi.json"),
    JSON.stringify(instance.openapi(), null, 2) + "\n",
  );
  fs.writeFileSync(
    path.join(projectRoot, "packages/contracts/schemas.json"),
    JSON.stringify(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          Action: actionSchema,
          ProposalEnvelope: proposalSchema,
          Criterion: criterionSchema,
          NoteRef: noteRefSchema,
        },
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await instance?.app.close();
  const relative = path.relative(os.tmpdir(), temporary);
  if (
    !relative.startsWith("secretary-contract-") ||
    relative.includes(path.sep)
  )
    throw new Error("Unsafe cleanup");
  fs.rmSync(temporary, { recursive: true, force: true });
}
