import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";

const executablePath = process.argv[2];
if (!executablePath) throw new Error("Supply the installed desktop executable path.");
const profile = await mkdtemp(path.join(os.tmpdir(), "btv-update-check-"));
let application;
try {
  application = await electron.launch({
    executablePath: path.resolve(executablePath),
    args: ["--no-sandbox"],
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1", BTV_USER_DATA_DIR: profile },
    timeout: 30000,
  });
  await application.firstWindow();
  const runtime = await application.evaluate(({ app, Menu, dialog }) => {
    globalThis.updateCheckMessages = [];
    dialog.showMessageBox = async (...args) => {
      globalThis.updateCheckMessages.push(args.at(-1));
      return { response: 1 };
    };
    const menu = Menu.getApplicationMenu();
    const help = menu.items.find(item => item.role === "help" || item.label === "Help");
    return { version: app.getVersion(), packaged: app.isPackaged, appImage: process.env.APPIMAGE,
      helpItems: help.submenu.items.map(item => item.label) };
  });
  assert.equal(runtime.packaged, true);
  assert.ok(runtime.helpItems.includes("About Big Tree Viewer"));
  assert.ok(runtime.helpItems.includes("Check for Updates..."));
  await application.evaluate(({ Menu }) => {
    Menu.getApplicationMenu().items.find(item => item.role === "help").submenu.items.find(item => item.label === "About Big Tree Viewer").click();
  });
  await expect.poll(() => application.evaluate(() => globalThis.updateCheckMessages.length)).toBe(1);
  const about = await application.evaluate(() => globalThis.updateCheckMessages[0]);
  assert.ok(about.detail.includes(`Version ${runtime.version}`));
  await application.evaluate(({ Menu }) => {
    globalThis.updateCheckMessages = [];
    Menu.getApplicationMenu().items.find(item => item.role === "help").submenu.items.find(item => item.label === "Check for Updates...").click();
  });
  await expect.poll(() => application.evaluate(() => globalThis.updateCheckMessages.length), { timeout: 30000 }).toBeGreaterThan(0);
  const updates = await application.evaluate(() => globalThis.updateCheckMessages);
  assert.ok(updates.some(item => /Is Up to Date|Update Available/.test(item.title)), JSON.stringify(updates));
  console.log(JSON.stringify({ runtime, about, updates }, null, 2));
} finally {
  await application?.close();
  await rm(profile, { recursive: true, force: true });
}
