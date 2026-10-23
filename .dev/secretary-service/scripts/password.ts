import readline from "node:readline/promises";
import { passwordHash } from "../apps/core/auth.js";
const terminal = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
const password = await terminal.question(
  "Password (input is visible locally; do not paste production secrets into chat): ",
);
terminal.close();
if (password.length < 12) throw new Error("Use at least 12 characters");
console.log(passwordHash(password));
