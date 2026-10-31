"use strict";
const crypto = require("crypto");
const N = +process.env.SCRYPT_N || 32768, R = 8, P = 1, KL = 64;
const scrypt = (pw, salt, n = N) => new Promise((res, rej) =>
  crypto.scrypt(pw, salt, KL, { N: n, r: R, p: P, maxmem: 256 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
async function hashPw(pw) {
  const salt = crypto.randomBytes(16), k = await scrypt(pw, salt);
  return `scrypt$${N}$${salt.toString("base64")}$${k.toString("base64")}`;
}
async function verifyPw(pw, stored) {
  try {
    const [, n, s, h] = String(stored).split("$"), k = await scrypt(pw, Buffer.from(s, "base64"), +n), b = Buffer.from(h, "base64");
    return b.length === k.length && crypto.timingSafeEqual(b, k);
  } catch (e) { return false; }
}
const sha = t => crypto.createHash("sha256").update(t).digest("hex");
const token = () => crypto.randomBytes(32).toString("base64url");
const uuid = () => crypto.randomUUID();
const COMMON = new Set(["password", "password1", "password123", "1234567890", "12345678", "123456789", "qwertyuiop", "admin12345", "letmein123", "welcome123", "iloveyou1", "changeme123"]);
function pwPolicy(pw, username) {
  if (typeof pw !== "string" || pw.length < 10) return "Password must be at least 10 characters";
  if (pw.length > 128) return "Password is too long";
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return "Password must not contain the username";
  if ([/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length < 2) return "Use at least two kinds of characters (letters, numbers, symbols)";
  if (COMMON.has(pw.toLowerCase())) return "That password is too common";
  return null;
}
function randomPassword() {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ", b = "abcdefghijkmnopqrstuvwxyz", c = "23456789", d = "!@#$%&*?", all = a + b + c + d;
  const pick = s => s[crypto.randomInt(s.length)];
  let out = [pick(a), pick(b), pick(c), pick(d)];
  while (out.length < 14) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out.join("");
}
// optional field-level encryption for integration secrets (SMS / STK gateway keys)
const key = () => (process.env.DATA_KEY ? crypto.createHash("sha256").update(process.env.DATA_KEY).digest() : null);
function encrypt(s) {
  const k = key(); if (!k || s == null || s === "" || String(s).startsWith("enc:")) return s;
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", k, iv), e = Buffer.concat([c.update(String(s), "utf8"), c.final()]);
  return "enc:" + Buffer.concat([iv, c.getAuthTag(), e]).toString("base64");
}
function decrypt(s) {
  const k = key(); if (!k || typeof s !== "string" || !s.startsWith("enc:")) return s;
  try { const b = Buffer.from(s.slice(4), "base64"), d = crypto.createDecipheriv("aes-256-gcm", k, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"); }
  catch (e) { return ""; }
}
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function unsafe(v, depth = 0) {            // reject prototype-pollution keys and absurd nesting
  if (depth > 40) return true;
  if (Array.isArray(v)) return v.some(x => unsafe(x, depth + 1));
  if (v && typeof v === "object") return Object.keys(v).some(k => BAD_KEYS.has(k) || unsafe(v[k], depth + 1));
  return false;
}
function pinPolicy(pin) {
  if (!/^\d{6,8}$/.test(String(pin))) return 'PIN must be 6 to 8 digits';
  const d = String(pin).split('').map(Number);
  if (d.every(x => x === d[0])) return 'PIN is too easy to guess (repeated digit)';
  if (d.every((x, i) => i === 0 || x - d[i - 1] === 1) || d.every((x, i) => i === 0 || d[i - 1] - x === 1)) return 'PIN is too easy to guess (sequence)';
  if (['121212', '123123', '112233', '123321', '101010', '696969', '000111', '12341234', '11223344'].includes(String(pin))) return 'PIN is too easy to guess';
  return null;
}
const legacyPin = pin => crypto.createHash('sha256').update('edbis:' + pin).digest('hex');   // hash format of the old browser-only version
module.exports = { pinPolicy, legacyPin, hashPw, verifyPw, sha, token, uuid, pwPolicy, randomPassword, encrypt, decrypt, unsafe };
