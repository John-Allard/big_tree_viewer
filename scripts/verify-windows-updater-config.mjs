import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
async function findExtractedFile(directory, filename) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === filename) return entryPath;
    if (entry.isDirectory()) {
      const nestedMatch = await findExtractedFile(entryPath, filename);
      if (nestedMatch) return nestedMatch;
    }
  }
  return null;
}

try {
  const outerDir = path.join(temporaryDir, "outer");
  const innerDir = path.join(temporaryDir, "inner");
  await Promise.all([mkdir(outerDir, { recursive: true }), mkdir(innerDir, { recursive: true })]);
  // Extract complete archives so verification does not depend on the platform-specific
  // separators used for NSIS internal paths.
  await execFileAsync(sevenZip, ["x", path.resolve(installerPath), `-o${outerDir}`, "-y"]);
  const applicationArchive = await findExtractedFile(outerDir, "app-64.7z");
  if (!applicationArchive) throw new Error("app-64.7z was not found after extracting the Windows installer.");
  await execFileAsync(sevenZip, ["x", applicationArchive, `-o${innerDir}`, "-y"]);
  const updateConfigurationPath = await findExtractedFile(innerDir, "app-update.yml");
  if (!updateConfigurationPath) {
    throw new Error("app-update.yml was not found in the packaged Windows application.");
  }
  const updateConfiguration = await readFile(updateConfigurationPath, "utf8");
  assert.match(updateConfiguration, /^provider:\s*github$/m);
  assert.match(updateConfiguration, /^owner:\s*John-Allard$/m);
  assert.match(updateConfiguration, /^repo:\s*big_tree_viewer$/m);
  console.log("The signed Windows installer contains a valid resources/app-update.yml.");
} finally {
  await rm(temporaryDir, { recursive: true, force: true });
}
