import fs from "node:fs";
import crypto from "node:crypto";
import { Tokenizer } from "@huggingface/tokenizers";
import { resource } from "./config.js";
let tokenizer:Tokenizer|undefined;
/** A pinned provider tokenizer plus protocol margin; actual usage is checked at settlement. */
export function inputTokenReservation(request:any,model?:string) {
  if(model!=="deepseek-flash")return Buffer.byteLength(JSON.stringify(request),"utf8")+256;
  if(!tokenizer) {
    const bytes=fs.readFileSync(resource("tokenizer/deepseek-v41.json"));
    if(crypto.createHash("sha256").update(bytes).digest("hex")!=="81f64d1248a68ce3663e07ab3ee48b851e5df0e32d27cb98e4c9a268151e8d99")
      throw new Error("TOKENIZER_INTEGRITY_FAILURE");
    tokenizer=new Tokenizer(JSON.parse(bytes.toString("utf8")),{});
  }
  return Math.ceil(tokenizer.encode(JSON.stringify(request)).ids.length*1.25)+512+(request.messages?.length??0)*16+(request.tools?.length??0)*64;
}
