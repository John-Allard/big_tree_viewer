import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getPath7za } = require("app-builder-lib/out/toolsets/7zip");
const execFileAsync = promisify(execFile);
const installerPath = process.argv[2];
if (!installerPath) throw new Error("Usage: node scripts/verify-windows-updater-config.mjs <installer.exe>");

const sevenZip = await getPath7za();
const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "btv-windows-updater-"));
try {
  const outerDir = path.join(temporaryDir, "outer");
  const innerDir = path.join(temporaryDir, "inner");
  await execFileAsync(sevenZip, ["e", path.resolve(installerPath), "$PLUGINSDIR/app-64.7z", `-o${outerDir}`, "-y"]);
  const applicationArchive = path.join(outerDir, "app-64.7z");
  await execFileAsync(sevenZip, ["e", applicationArchive, "resources/app-update.yml", `-o${innerDir}`, "-y"]);
  const updateConfiguration = await readFile(path.join(innerDir, "app-update.yml"), "utf8");
  assert.match(updateConfiguration, /^provider:\s*github$/m);
  assert.match(updateConfiguration, /^owner:\s*John-Allard$/m);
  assert.match(updateConfiguration, /^repo:\s*big_tree_viewer$/m);
  console.log("The signed Windows installer contains a valid resources/app-update.yml.");
} finally {
  await rm(temporaryDir, { recursive: true, force: true });
}
