import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "service-payment-api-test-"));
process.env.APP_DATA_DIR = path.join(root, "data");
process.env.APP_DATABASE_PATH = path.join(root, "app.sqlite");
process.env.INITIAL_ADMIN_PASSWORD = "initial-password-1";

const { Store } = await import("./store");
const { createApp } = await import("./app");

const store = new Store();
const server = createApp({ store, broadcast: () => undefined }).listen(0);
let base = "";
let adminToken = "";
let memberToken = "";
let memberId = "";

type Json = Record<string, any>;

async function call(method: string, url: string, options: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: BodyInit } = {}) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(options.token ? { "x-auth-token": options.token } : {}),
      ...options.headers
    },
    body: options.raw ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined)
  });
  const contentType = response.headers.get("content-type") ?? "";
  const json = contentType.includes("json") ? ((await response.json()) as Json) : null;
  return { status: response.status, json, response };
}

async function login(userId: string, password: string) {
  const result = await call("POST", "/api/auth/login", { body: { userId, password } });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return result.json!.payload.token as string;
}

before(async () => {
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admin = store.read().users[0];
  adminToken = await login(admin.id, "initial-password-1");
  const created = await call("POST", "/api/users", { token: adminToken, body: { name: "Участник", password: "member-password-1", telegramId: "" } });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  memberId = created.json!.payload.users.find((user: Json) => user.name === "Участник").id;
  await call("POST", `/api/services/${store.read().services[0].id}/members`, { token: adminToken, body: { userId: memberId } });
  memberToken = await login(memberId, "member-password-1");
});

after(() => {
  server.close();
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("admin mutations return state scoped to the admin, never to an anonymous viewer", async () => {
  const result = await call("POST", "/api/currencies", { token: adminToken, body: { code: "KZT", name: "Тенге", rateToRub: 0.18 } });
  assert.equal(result.status, 200);
  assert.equal(result.json!.payload.viewerId, store.read().users[0].id);
  assert.ok(result.json!.payload.settings.telegram, "admin sees Telegram settings");
  assert.equal("botToken" in result.json!.payload.settings.telegram, false, "the token itself is never sent");
});

test("participants get a filtered state and cannot reach admin endpoints", async () => {
  const state = await call("GET", "/api/state", { token: memberToken });
  assert.equal(state.json!.payload.settings.telegram, null);
  assert.equal((await call("POST", "/api/wall/tags", { token: memberToken, body: { name: "x" } })).status, 403);
  assert.equal((await call("GET", "/api/database/export.json", { token: memberToken })).status, 403);
  assert.equal((await call("POST", "/api/debits/manual", { token: memberToken, body: { serviceId: "x" } })).status, 403);
});

test("a manual payment credits the balance and records history; balance cannot be overwritten directly", async () => {
  const serviceId = store.read().services[0].id;
  const paid = await call("POST", "/api/payments", { token: memberToken, body: { serviceId, amount: 250.5 } });
  assert.equal(paid.status, 200, JSON.stringify(paid.json));
  assert.equal(paid.json!.payload.payment.method, "manual");
  assert.equal(store.read().users.find((user) => user.id === memberId)!.balance, 250.5);

  const online = await call("POST", "/api/payments", { token: memberToken, body: { serviceId, amount: 10, method: "sbp" } });
  assert.equal(online.json!.payload.payment.method, "manual", "online methods no longer exist");

  await call("PUT", `/api/users/${memberId}`, { token: adminToken, body: { name: "Участник", balance: 999999 } });
  assert.equal(store.read().users.find((user) => user.id === memberId)!.balance, 260.5);

  const history = await call("GET", `/api/payments?userId=${memberId}`, { token: adminToken });
  assert.equal(history.json!.payload.total, 2);
});

test("participants cannot record payments for someone else or when manual entry is off", async () => {
  const serviceId = store.read().services[0].id;
  const other = await call("POST", "/api/payments", { token: memberToken, body: { serviceId, amount: 5, userId: store.read().users[0].id } });
  assert.equal(other.status, 403);
  await call("PUT", "/api/settings/payments", { token: adminToken, body: { manualEnabled: false } });
  assert.equal((await call("POST", "/api/payments", { token: memberToken, body: { serviceId, amount: 5 } })).status, 400);
  assert.equal((await call("POST", "/api/payments", { token: adminToken, body: { serviceId, amount: 5, userId: memberId } })).status, 200);
  await call("PUT", "/api/settings/payments", { token: adminToken, body: { manualEnabled: true } });
});

test("the last administrator cannot be removed or demoted", async () => {
  const adminId = store.read().users[0].id;
  assert.equal((await call("DELETE", `/api/users/${adminId}`, { token: adminToken })).status, 400);
  assert.equal((await call("PUT", `/api/users/${adminId}`, { token: adminToken, body: { botAdmin: false } })).status, 400);
});

test("saving Telegram settings never rewinds the update offset or toggles polling", async () => {
  store.write((data) => {
    data.settings.telegram.updateOffset = 500;
  });
  const saved = await call("PUT", "/api/settings/telegram", {
    token: adminToken,
    body: { enabled: false, chatId: "-1", updateOffset: 3, pollingEnabled: true, lastError: "x" }
  });
  assert.equal(saved.status, 200);
  assert.equal(store.read().settings.telegram.updateOffset, 500);
  assert.equal(store.read().settings.telegram.pollingEnabled, false);
});

test("the Telegram webhook ignores duplicates and edited messages", async () => {
  const secret = store.read().settings.telegram.webhookSecret;
  store.write((data) => {
    data.settings.telegram.enabled = true;
    data.settings.telegram.updateOffset = 0;
    data.users.find((user) => user.id === memberId)!.telegramId = "4242";
  });
  const balance = () => store.read().users.find((user) => user.id === memberId)!.balance;
  const start = balance();
  const message = { chat: { id: 1, type: "private" }, from: { id: 4242 }, text: "/pay 10" };

  assert.equal((await call("POST", `/api/telegram/webhook/${secret}`, { body: { update_id: 7, message } })).status, 200);
  assert.equal(balance(), start + 10);
  await call("POST", `/api/telegram/webhook/${secret}`, { body: { update_id: 7, message } });
  await call("POST", `/api/telegram/webhook/${secret}`, { body: { update_id: 8, edited_message: message } });
  assert.equal(balance(), start + 10, "retries and edits do not credit again");
  assert.equal((await call("POST", "/api/telegram/webhook/wrong-secret", { body: { update_id: 9, message } })).status, 403);
  store.write((data) => {
    data.settings.telegram.enabled = false;
  });
});

test("uploaded HTML is served as a sandboxed attachment, and JSON files upload intact", async () => {
  const html = await call("POST", "/api/wall/files", {
    token: memberToken,
    headers: { "Content-Type": "text/html", "x-file-name": "evil.html" },
    raw: "<script>alert(1)</script>"
  });
  assert.equal(html.status, 200, JSON.stringify(html.json));
  const download = await fetch(`${base}${html.json!.payload.url}`);
  assert.equal(download.headers.get("content-type"), "application/octet-stream");
  assert.match(download.headers.get("content-disposition") ?? "", /^attachment/);
  assert.match(download.headers.get("content-security-policy") ?? "", /sandbox/);

  const json = await call("POST", "/api/wall/files", {
    token: memberToken,
    headers: { "Content-Type": "application/json", "x-file-name": "config.json" },
    raw: '{"a":1}'
  });
  assert.equal(json.status, 200, JSON.stringify(json.json));
  assert.equal(json.json!.payload.size, 7);
});

test("removing a post preview with null actually clears it", async () => {
  const image = await call("POST", "/api/wall/files", {
    token: adminToken,
    headers: { "Content-Type": "image/png", "x-file-name": "p.png" },
    raw: new Uint8Array([137, 80, 78, 71])
  });
  const created = await call("POST", "/api/wall/posts", { token: adminToken, body: { title: "Preview", previewFileId: image.json!.payload.id } });
  const post = created.json!.payload.posts.rows.find((row: Json) => row.title === "Preview");
  assert.equal(post.previewFileId, image.json!.payload.id);
  await call("PUT", `/api/wall/posts/${post.id}`, { token: adminToken, body: { title: "Preview", previewFileId: null } });
  assert.equal(store.read().wallPosts.find((item) => item.id === post.id)!.previewFileId, null);
});

test("legacy JSON export downloads without session tokens and imports back", async () => {
  const exported = await call("GET", "/api/database/export.json", { token: adminToken });
  assert.equal(exported.status, 200);
  assert.match(exported.response.headers.get("content-disposition") ?? "", /\.json"/);
  const backup = exported.json!;
  assert.deepEqual(backup.settings.security.sessions, {});
  const restored = await call("POST", "/api/database/import", { token: adminToken, body: backup });
  assert.equal(restored.status, 200, JSON.stringify(restored.json));
  assert.equal(store.read().users.length, backup.users.length);
  // The import replaced the sessions, so the old token is no longer valid.
  assert.equal((await call("GET", "/api/state", { token: adminToken })).status, 401);
});
