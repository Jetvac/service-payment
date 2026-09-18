import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store";

const store = new Store();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "service-payment-verify-"));
try {
  await store.backupTo(path.join(temporary, "verified.sqlite"));
  console.log(`Verified SQLite: ${store.read().users.length} users, ${store.read().payments.length} payments, ${store.read().wallPosts.length} posts, ${store.read().wallFiles.length} files`);
} finally {
  store.close();
  fs.rmSync(temporary, { recursive: true, force: true });
}
