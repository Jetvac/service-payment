import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import Database from "better-sqlite3";
import { seedData, addDeposit, addDebit } from "./domain";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "service-payment-store-test-"));
process.env.APP_DATA_DIR = path.join(root, "data");
process.env.APP_DATABASE_PATH = path.join(root, "nested", "app.sqlite");
const { Store } = await import("./store");
after(() => fs.rmSync(root, { recursive: true, force: true }));
const bytes = Buffer.from([0, 255, 128, 17, 0, 42]);
const file = { id: "attachment", originalName: "example.bin", storageName: "old.bin", mimeType: "application/octet-stream", size: bytes.length, url: "/api/wall/files/attachment/download", uploadedBy: "", createdAt: "2026-01-01T00:00:00.000Z" };
const legacy = seedData();
addDeposit(legacy, { userId: legacy.users[0].id, serviceId: legacy.services[0].id, amount: 321.45, currency: "RUB", source: "manual" });
addDebit(legacy, { userId: legacy.users[0].id, serviceId: legacy.services[0].id, amount: 12, periodStart: file.createdAt, periodEnd: "2026-02-01T00:00:00.000Z", source: "manual" });
legacy.wallFiles = [file];
legacy.wallPosts = [{ id: "post", title: "Old post", content: "Text", previewFileId: file.id, fileIds: [file.id], tagIds: ["tag"], authorId: legacy.users[0].id, serviceId: legacy.services[0].id, views: 17, createdAt: file.createdAt, updatedAt: file.createdAt }];
legacy.wallTags = [{ id: "tag", name: "Tag", color: "#123456", pinned: true, archived: false, createdAt: file.createdAt }];
legacy.wallComments = [{ id: "comment", postId: "post", parentId: null, authorId: legacy.users[0].id, content: "Comment", fileIds: [file.id], deletedAt: null, createdAt: file.createdAt, updatedAt: file.createdAt }];
legacy.payments = [{ id: "payment", userId: legacy.users[0].id, serviceId: legacy.services[0].id, amount: 123, currency: "RUB", method: "manual", provider: "manual", status: "succeeded", externalId: "", confirmationUrl: "", description: "Payment", comment: "", depositId: null, failureReason: "", createdAt: file.createdAt, updatedAt: file.createdAt, paidAt: file.createdAt }];
legacy.settings.telegram.botToken = "test-token";
legacy.settings.payments.secretKey = "test-secret";
(legacy as unknown as Record<string, unknown>).latencyChecks = [{ id: "discard" }];
(legacy.services[0] as unknown as Record<string, unknown>).connection = { host: "discard" };
fs.mkdirSync(path.join(process.env.APP_DATA_DIR, "wall-files"), { recursive: true });
fs.writeFileSync(path.join(process.env.APP_DATA_DIR, "wall-files", file.storageName), bytes);
fs.writeFileSync(path.join(process.env.APP_DATA_DIR, "db.json"), JSON.stringify(legacy));

test("legacy JSON and disk attachments migrate without losing business data", async () => {
  const store = new Store();
  try {
    assert.deepEqual(store.readWallFile(file.id), bytes);
    const migrated = store.exportData();
    for (const key of ["payments", "deposits", "debits", "memberships", "wallPosts", "wallFiles", "wallTags", "wallComments"] as const) assert.deepEqual(migrated[key], legacy[key]);
    assert.equal(migrated.users[0].balance, legacy.users[0].balance);
    assert.equal(migrated.settings.telegram.botToken, "test-token");
    assert.equal("latencyChecks" in migrated, false);
    assert.equal("connection" in migrated.services[0], false);
    assert.ok(fs.existsSync(path.join(process.env.APP_DATA_DIR!, "db.json")));
    await store.backupTo(path.join(root, "complete.sqlite"));
  } finally { store.close(); }
});

test("SQLite round trip restores every section and binary attachment, including after restart", () => {
  const store = new Store();
  const expected = store.exportData();
  try {
    store.write(data => { data.payments = []; data.wallPosts = []; data.wallComments = []; data.wallTags = []; data.settings.telegram.botToken = "changed"; data.users[0].balance = -100; });
    store.deleteWallFileBlob(file.id);
    store.replaceWithDatabase(path.join(root, "complete.sqlite"));
    assert.deepEqual(store.exportData(), expected);
    assert.deepEqual(store.readWallFile(file.id), bytes);
  } finally { store.close(); }
  const reopened = new Store();
  try { assert.deepEqual(reopened.exportData(), expected); assert.deepEqual(reopened.readWallFile(file.id), bytes); }
  finally { reopened.close(); }
});

test("incomplete and invalid imports preserve the current state and blobs", () => {
  const store = new Store();
  try {
    const expected = store.exportData();
    const invalid = path.join(root, "incomplete.sqlite");
    fs.copyFileSync(path.join(root, "complete.sqlite"), invalid);
    const db = new Database(invalid);
    db.prepare("DELETE FROM wall_file_blobs").run(); db.close();
    assert.throws(() => store.replaceWithDatabase(invalid), /файл/);
    assert.throws(() => store.replace({ ...expected, payments: "invalid" }), /payments/);
    assert.deepEqual(store.exportData(), expected);
    assert.deepEqual(store.readWallFile(file.id), bytes);
  } finally { store.close(); }
});

test("a failed transaction rolls back both state and binary files", () => {
  const store = new Store();
  try {
    const expected = store.exportData();
    const db = new Database(store.getDatabasePath());
    db.exec("CREATE TRIGGER reject_import BEFORE INSERT ON wall_file_blobs BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
    try {
      assert.throws(() => store.replaceWithDatabase(path.join(root, "complete.sqlite")), /test write failure/);
      assert.deepEqual(store.exportData(), expected);
      assert.deepEqual(store.readWallFile(file.id), bytes);
    } finally { db.exec("DROP TRIGGER reject_import"); db.close(); }
  } finally { store.close(); }
});

test("JSON restores supplied wall sections and preserves omitted legacy sections", () => {
  const store = new Store();
  try {
    const backup = store.exportData(); backup.wallPosts[0].title = "Restored title";
    store.replace(backup);
    assert.equal(store.read().wallPosts[0].title, "Restored title");
    const financial = store.exportData() as unknown as Record<string, unknown>;
    for (const key of ["wallFiles", "wallPosts", "wallTags", "wallComments"]) delete financial[key];
    store.replace(financial);
    assert.equal(store.read().wallPosts[0].title, "Restored title");
    assert.deepEqual(store.readWallFile(file.id), bytes);
  } finally { store.close(); }
});

test("export refuses a missing attachment", async () => {
  const store = new Store();
  try {
    store.deleteWallFileBlob(file.id);
    await assert.rejects(store.backupTo(path.join(root, "broken.sqlite")), /файл/);
    store.saveWallFile(file, bytes);
  } finally { store.close(); }
});

