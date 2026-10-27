import crypto from "node:crypto";
export function passwordHash(
  password: string,
  salt = crypto.randomBytes(16).toString("hex"),
) {
  const key = crypto.scryptSync(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024,
  });
  return `scrypt$${salt}$${key.toString("hex")}`;
}
export function verifyPassword(password: string, stored: string) {
  try {
    const [type, salt, expected] = stored.split("$");
    if (type !== "scrypt" || !salt || !expected || password.length > 1024)
      return false;
    const computed = passwordHash(password, salt).split("$")[2];
    return safeEqual(computed, expected);
  } catch {
    return false;
  }
}
export function safeEqual(a: string, b: string) {
  const one = Buffer.from(a),
    two = Buffer.from(b);
  return one.length === two.length && crypto.timingSafeEqual(one, two);
}
export function issueSession(key: string, now = Date.now()) {
  const payload = Buffer.from(
    JSON.stringify({
      exp: now + 7 * 86400000,
      nonce: crypto.randomBytes(16).toString("hex"),
    }),
  ).toString("base64url");
  return (
    payload +
    "." +
    crypto.createHmac("sha256", key).update(payload).digest("base64url")
  );
}
export function validSession(
  cookie: string | undefined,
  key: string,
  now = Date.now(),
) {
  if (!cookie) return false;
  const [payload, signature] = cookie.split(".");
  if (!payload || !signature) return false;
  const expected = crypto
    .createHmac("sha256", key)
    .update(payload)
    .digest("base64url");
  if (!safeEqual(signature, expected)) return false;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > now;
  } catch {
    return false;
  }
}
