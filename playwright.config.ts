import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "service-payment-e2e-"));

export default defineConfig({
  testDir: "./tests",
  outputDir: path.join(os.tmpdir(), "service-payment-playwright-results"),
  timeout: 30_000,
  expect: { timeout: 7_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4190",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } }
  ],
  webServer: {
    command: "npm start",
    url: "http://127.0.0.1:4190/api/health",
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ...process.env,
      PORT: "4190",
      APP_DATA_DIR: testDataDir,
      INITIAL_ADMIN_PASSWORD: "test-password-123",
      DISABLE_BACKGROUND_JOBS: "true"
    }
  }
});
