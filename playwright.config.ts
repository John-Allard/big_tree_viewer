import fs from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const systemChromePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH
  ?? (fs.existsSync("/usr/bin/google-chrome-stable") ? "/usr/bin/google-chrome-stable" : undefined);

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: undefined,
        launchOptions: systemChromePath ? { executablePath: systemChromePath } : undefined,
      },
    },
    ...(process.env.PLAYWRIGHT_INCLUDE_WEBKIT === "1"
      ? [
          {
            name: "webkit",
            use: {
              ...devices["Desktop Safari"],
            },
          },
          {
            name: "iphone-safari",
            use: {
              ...devices["iPhone 13"],
              browserName: "webkit",
            },
          },
        ]
      : []),
  ],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --strictPort --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
    timeout: 120 * 1000,
  },
});
