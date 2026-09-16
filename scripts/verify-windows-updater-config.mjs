import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const applicationDirectory = process.argv[2];
if (!applicationDirectory) {
  throw new Error("Usage: node scripts/verify-windows-updater-config.mjs <unpacked-application-directory>");
}

const updateConfigurationPath = path.join(path.resolve(applicationDirectory), "resources", "app-update.yml");
const updateConfiguration = await readFile(updateConfigurationPath, "utf8");
assert.match(updateConfiguration, /^provider:\s*github$/m);
assert.match(updateConfiguration, /^owner:\s*John-Allard$/m);
assert.match(updateConfiguration, /^repo:\s*big_tree_viewer$/m);
console.log("The signed Windows application payload contains a valid resources/app-update.yml.");
