import crypto from "node:crypto";

const algorithm = "scrypt";
const keyLength = 64;
const cost = 16_384;
const blockSize = 8;
const parallelization = 1;

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function hashPassword(password: string) {
  const normalized = String(password ?? "");
  if (!normalized) throw new Error("Пароль не может быть пустым");
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(normalized, salt, keyLength, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: 64 * 1024 * 1024
  });
  return [algorithm, cost, blockSize, parallelization, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

export function isPasswordHash(value: string) {
  return value.startsWith(`${algorithm}$`);
}

export function verifyPassword(stored: string, candidate: string) {
  const value = String(stored ?? "");
  const input = String(candidate ?? "");
  if (!value || !input) return false;

  if (!isPasswordHash(value)) {
    const left = Buffer.from(value);
    const right = Buffer.from(input);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  }

  const [name, rawCost, rawBlockSize, rawParallelization, rawSalt, rawHash] = value.split("$");
  if (name !== algorithm || !rawSalt || !rawHash) return false;

  try {
    const expected = Buffer.from(rawHash, "base64url");
    const actual = crypto.scryptSync(input, Buffer.from(rawSalt, "base64url"), expected.length, {
      N: Number(rawCost),
      r: Number(rawBlockSize),
      p: Number(rawParallelization),
      maxmem: 64 * 1024 * 1024
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function assertStrongPassword(password: string) {
  if (password.length < 8) throw new Error("Пароль должен содержать минимум 8 символов");
  if (password.length > 256) throw new Error("Пароль слишком длинный");
}

export function sessionExpiresAt(from = new Date()) {
  return new Date(from.getTime() + SESSION_TTL_MS).toISOString();
}

export function sessionIsActive(session: { expiresAt?: string; createdAt: string } | undefined, now = Date.now()) {
  if (!session) return false;
  const expiresAt = new Date(session.expiresAt ?? new Date(new Date(session.createdAt).getTime() + SESSION_TTL_MS)).getTime();
  return Number.isFinite(expiresAt) && expiresAt > now;
}
