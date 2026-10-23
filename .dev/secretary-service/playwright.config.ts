import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  timeout: 30000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "chromium",
    baseURL: "http://127.0.0.1:3187",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run fixture",
    url: "http://127.0.0.1:3187/healthz",
    timeout: 30000,
    reuseExistingServer: false,
    env: {
      SECRETARY_DEMO_PORT: "3187",
      SECRETARY_FIXTURE_ISOLATED: "1",
      SECRETARY_FIXTURE_GIT: "1",
    },
  },
});
