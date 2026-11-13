import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Пароль").fill("test-password-123");
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор", level: 1 })).toBeVisible();
}

async function openSection(page: Page, name: string) {
  // Below 960px the navigation lives in an off-canvas drawer.
  if ((page.viewportSize()?.width ?? 1280) <= 960) await page.getByRole("button", { name: "Меню" }).click();
  await page.locator(".nav").getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}

test("a manual payment is credited immediately and appears in the history", async ({ page }) => {
  await login(page);
  await openSection(page, "Внести оплату");
  await page.getByLabel("Сумма").fill("321.45");
  await page.getByRole("button", { name: /Зачислить 321,45/ }).click();
  await expect(page.getByText("Оплата зачислена")).toBeVisible();
  await expect(page.locator(".table").getByText(/321,45/).first()).toBeVisible();
  await expect(page.getByText(/ЮKassa|СберБанк Онлайн|Оплатить онлайн/)).toHaveCount(0);
});

test("settings only offer manual payment details and keep secrets masked", async ({ page }) => {
  await login(page);
  await openSection(page, "Настройки");
  await expect(page.getByRole("heading", { name: "Приём оплаты" })).toBeVisible();
  await expect(page.getByLabel("Счёт или карта")).toBeVisible();
  await expect(page.getByLabel("Bot token")).toHaveAttribute("type", "password");
  await expect(page.getByText(/Shop ID|Секретный ключ|ЮKassa/)).toHaveCount(0);
});

test("pages have no horizontal overflow", async ({ page }) => {
  await login(page);
  for (const section of ["Внести оплату", "Сервисы", "История", "Стена", "Участники", "Настройки"]) {
    await openSection(page, section);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, section).toBeLessThanOrEqual(1);
  }
});

test("a manual debit asks for confirmation and succeeds without Telegram", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await login(page);
  await openSection(page, "Сервисы");
  await page.getByRole("button", { name: "Списать", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Списать сейчас?" });
  await expect(dialog).toBeVisible();
  const responsePromise = page.waitForResponse((response) => response.url().includes("/api/debits/manual"));
  await dialog.getByRole("button", { name: /^Списать/ }).click();
  expect((await responsePromise).status()).toBe(200);
  await expect(page.getByText(/Списано с 1/)).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("Telegram action errors are shown without an unhandled promise", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await login(page);
  const token = await page.evaluate(() => localStorage.getItem("vpn-payment-auth-token")!);
  await page.request.put("/api/settings/telegram", { headers: { "x-auth-token": token }, data: { botToken: "123456:test-token", enabled: true } });
  await page.route("**/api/telegram/test", (route) =>
    route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Telegram недоступен" }) })
  );
  await page.reload();
  await openSection(page, "Настройки");
  await page.getByRole("button", { name: /^Тест/ }).click();
  await expect(page.getByText("Telegram недоступен")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("SQLite and legacy JSON backups download, and a full backup restores wall attachments", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  const token = await page.evaluate(() => localStorage.getItem("vpn-payment-auth-token")!);
  const headers = { "x-auth-token": token };
  const upload = await page.request.post("/api/wall/files", {
    headers: { ...headers, "Content-Type": "application/octet-stream", "x-file-name": "backup-proof.bin" },
    data: Buffer.from([0, 255, 42, 128])
  });
  expect(upload.ok()).toBeTruthy();
  const attachment = (await upload.json()).payload;
  const created = await page.request.post("/api/wall/posts", {
    headers,
    data: { title: `Backup proof ${testInfo.project.name}`, content: "Restore this post", fileIds: [attachment.id], tagIds: [] }
  });
  expect(created.ok()).toBeTruthy();
  const post = (await created.json()).payload.posts.rows[0];

  await openSection(page, "Настройки");

  const jsonDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: /Скачать JSON/ }).click();
  const legacy = await jsonDownload;
  expect(legacy.suggestedFilename()).toMatch(/\.json$/);
  const legacyPath = testInfo.outputPath("legacy-backup.json");
  await legacy.saveAs(legacyPath);
  const legacyData = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
  expect(legacyData.wallPosts.some((item: { id: string }) => item.id === post.id)).toBeTruthy();
  expect(legacyData.settings.security.sessions).toEqual({});

  const sqliteDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: /Скачать БД/ }).click();
  const backupPath = testInfo.outputPath("full-backup.sqlite");
  await (await sqliteDownload).saveAs(backupPath);

  const deleted = await page.request.delete(`/api/wall/posts/${post.id}`, { headers });
  expect(deleted.ok()).toBeTruthy();

  await page.getByLabel("Файл резервной копии").setInputFiles(backupPath);
  await page.getByRole("dialog", { name: "Восстановить базу из копии?" }).getByRole("button", { name: "Восстановить" }).click();
  await expect(page.getByText("База восстановлена. Войдите с паролем из резервной копии")).toBeVisible();
  await page.getByLabel("Пароль").fill("test-password-123");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Обзор", level: 1 })).toBeVisible();

  const newToken = await page.evaluate(() => localStorage.getItem("vpn-payment-auth-token")!);
  const restored = await page.request.get(`/api/wall/posts/${post.id}`, { headers: { "x-auth-token": newToken } });
  expect(restored.ok()).toBeTruthy();
  const file = await page.request.get(`/api/wall/files/${attachment.id}/download`);
  expect(await file.body()).toEqual(Buffer.from([0, 255, 42, 128]));
  expect(errors).toEqual([]);
});
