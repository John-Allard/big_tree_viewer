import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.resolve(process.argv[2] ?? path.join(projectRoot, "release"));
const { default: packageJson } = await import(path.join(projectRoot, "package.json"), { with: { type: "json" } });
const { version } = packageJson;
const releaseDate = new Date().toISOString();

const targets = [
  { metadata: "latest.yml", artifacts: ["Big-Tree-Viewer-Windows-x64.exe"] },
  { metadata: "latest-mac.yml", artifacts: ["Big-Tree-Viewer-macOS-universal.zip"] },
  {
    metadata: "latest-linux.yml",
    artifacts: ["Big-Tree-Viewer-Linux-x86_64.AppImage", "Big-Tree-Viewer-Linux-x86_64.deb"],
  },
];

async function sha512(filePath) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("base64");
}

for (const target of targets) {
  const files = await Promise.all(target.artifacts.map(async (artifact) => {
    const artifactPath = path.join(outputDirectory, artifact);
    const [fileInfo, checksum] = await Promise.all([stat(artifactPath), sha512(artifactPath)]);
    return { artifact, size: fileInfo.size, checksum };
  }));
  const primary = files[0];
  const metadata = [
    `version: ${JSON.stringify(version)}`,
    "files:",
    ...files.flatMap(file => [
      `  - url: ${JSON.stringify(file.artifact)}`,
      `    sha512: ${file.checksum}`,
      `    size: ${file.size}`,
    ]),
    `path: ${JSON.stringify(primary.artifact)}`,
    `sha512: ${primary.checksum}`,
    `releaseDate: ${JSON.stringify(releaseDate)}`,
    "",
  ].join("\n");
  await writeFile(path.join(outputDirectory, target.metadata), metadata, "utf8");
}
