import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, isPasswordHash, sessionExpiresAt, sessionIsActive, verifyPassword } from "./security";

test("passwords are stored as salted scrypt hashes", () => {
  const first = hashPassword("correct horse battery staple");
  const second = hashPassword("correct horse battery staple");
  assert.ok(isPasswordHash(first));
  assert.notEqual(first, second);
  assert.equal(verifyPassword(first, "correct horse battery staple"), true);
  assert.equal(verifyPassword(first, "wrong password"), false);
});

test("expired sessions are rejected", () => {
  const createdAt = new Date("2026-01-01T00:00:00.000Z").toISOString();
  const expiresAt = sessionExpiresAt(new Date(createdAt));
  assert.equal(sessionIsActive({ createdAt, expiresAt }, new Date("2026-01-02T00:00:00.000Z").getTime()), true);
  assert.equal(sessionIsActive({ createdAt, expiresAt }, new Date("2026-02-02T00:00:00.000Z").getTime()), false);
});
