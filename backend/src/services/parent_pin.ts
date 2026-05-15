/** 家长 PIN 主从同步 (v0.4.3+).
 *
 * server 持有 PIN 的 PBKDF2 hash + salt, hello_ack / set_pin REST 时把
 * (hash, salt) 推给所有 child 设备. Agent 直接 set_pin_raw_hash 不再自己 hash.
 *
 * PBKDF2-SHA256 + 16 byte salt + 240000 iter + 32 byte output — 跟 Win
 * agent protector/pin_manager.py + Android PinManager.kt 完全同算法,
 * Agent 拿到的 hashHex 跟自己本地 hash 同款, 直接对账.
 */
import crypto from "node:crypto";

const ITERATIONS = 240_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32; // 32 byte = 64 hex chars

export interface PinHash {
  hash_hex: string; // 64 hex chars
  salt_hex: string; // 32 hex chars
}

/** 用 PIN 明文计算 hash + 随机 salt. 用于家长后台首次设 PIN. */
export function hashNewPin(pin: string): PinHash {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.pbkdf2Sync(pin, salt, ITERATIONS, KEY_BYTES, "sha256");
  return { hash_hex: hash.toString("hex"), salt_hex: salt.toString("hex") };
}

/** 用 PIN + 已存 salt 重算 hash (验证用; server 端目前不验证, 留作 future). */
export function hashPinWithSalt(pin: string, saltHex: string): string {
  const salt = Buffer.from(saltHex, "hex");
  const hash = crypto.pbkdf2Sync(pin, salt, ITERATIONS, KEY_BYTES, "sha256");
  return hash.toString("hex");
}
