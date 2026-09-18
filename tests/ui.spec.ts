import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Пароль").fill("test-password-123");
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
}

test("payment flow is reachable from the sidebar and credits a manual payment", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Внести оплату" }).click();
  await expect(page.getByRole("heading", { name: "Внести оплату", level: 1 })).toBeVisible();
  await page.getByLabel("Сумма, ₽").fill("321.45");
  await page.getByRole("button", { name: /Без банка.*Зачислить сразу/, exact: true }).click();
  await page.getByRole("button", { name: "Зачислить без банка" }).click();
  await expect(page.getByText("Оплата зачислена")).toBeVisible();
  await expect(page.getByText(/321,45/).first()).toBeVisible();
});

test("admin payment configuration is present and secrets are masked", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Telegram" }).click();
  await expect(page.getByRole("heading", { name: "Приём оплаты" })).toBeVisible();
  await expect(page.getByLabel("Секретный ключ")).toHaveAttribute("type", "password");
  await expect(page.getByLabel("Счёт зачисления")).toBeVisible();
});

test("main payment flow has no viewport overflow", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Внести оплату" }).click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("full backup restores wall attachments through the system import button", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await login(page);
  await expect(page.getByText(/Пинг пользователей|История задержки|Последние замеры/)).toHaveCount(0);
  const token = await page.evaluate(() => localStorage.getItem("vpn-payment-auth-token")!);
  const headers = { "x-auth-token": token };
  const upload = await page.request.post("/api/wall/files", {
    headers: { ...headers, "Content-Type": "application/octet-stream", "x-file-name": "backup-proof.bin" },
    data: Buffer.from([0, 255, 42, 128])
  });
  expect(upload.ok()).toBeTruthy();
  const attachment = (await upload.json()).payload;
  const created = await page.request.post("/api/wall/posts", {
    headers, data: { title: `Backup proof ${testInfo.project.name}`, content: "Restore this post", fileIds: [attachment.id], tagIds: [] }
  });
  expect(created.ok()).toBeTruthy();
  const post = (await created.json()).payload.posts.rows[0];
  await page.getByRole("button", { name: "Telegram", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать БД", exact: true }).click();
  const download = await downloadPromise;
  const backupPath = testInfo.outputPath("full-backup.sqlite");
  await download.saveAs(backupPath);
  const deleted = await page.request.delete(`/api/wall/posts/${post.id}`, { headers });
  expect(deleted.ok()).toBeTruthy();
  await page.locator('input[type="file"][accept*=".sqlite"]').setInputFiles(backupPath);
  await expect(page.getByText("База загружена. Войдите с паролем из резервной копии")).toBeVisible();
  await page.getByLabel("Пароль").fill("test-password-123");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Обзор", exact: true })).toBeVisible();
  const newToken = await page.evaluate(() => localStorage.getItem("vpn-payment-auth-token")!);
  const restored = await page.request.get(`/api/wall/posts/${post.id}`, { headers: { "x-auth-token": newToken } });
  expect(restored.ok()).toBeTruthy();
  const file = await page.request.get(`/api/wall/files/${attachment.id}/download`);
  expect(await file.body()).toEqual(Buffer.from([0, 255, 42, 128]));
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("dashboard.png"), fullPage: true });
});
