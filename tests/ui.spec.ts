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
  await expect(page.getByRole("heading", { name: "Внести оплату" })).toBeVisible();
  await page.getByLabel("Сумма, ₽").fill("321.45");
  await page.getByRole("button", { name: /Без банка.*Зачислить сразу/, exact: true }).click();
  await page.getByRole("button", { name: "Зачислить без банка" }).click();
  await expect(page.getByText("Оплата зачислена")).toBeVisible();
  await expect(page.getByText("321,45")).toBeVisible();
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
