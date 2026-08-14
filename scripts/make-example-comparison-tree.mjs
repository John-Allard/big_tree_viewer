import { gunzipSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const sourcePath = resolve("public/example_tree.btvsession");
const outputPath = resolve("public/example_comparison_tree.nwk");
const session = JSON.parse(gunzipSync(readFileSync(sourcePath)).toString("utf8"));
const newick = session?.tree?.newick;
if (typeof newick !== "string" || !newick.trim()) {
  throw new Error("The bundled example session does not contain Newick text.");
}

const tips = [];
const tipPattern = /([,(])('(?:''|[^'])*'|"(?:\\"|[^"])*"|[^()[\],:;\s]+)(?=:)/g;
for (const match of newick.matchAll(tipPattern)) {
  const label = match[2];
  const start = (match.index ?? 0) + match[1].length;
  tips.push({ start, end: start + label.length, label });
}
if (tips.length < 100) {
  throw new Error(`Only ${tips.length} tips were found in the bundled example tree.`);
}

const blockSize = Math.min(1_500, Math.floor(tips.length / 12));
const anchors = [0.08, 0.32, 0.58, 0.84].map((fraction) => (
  Math.min(tips.length - blockSize, Math.floor(tips.length * fraction))
));
const replacementByTip = new Map();
for (let blockIndex = 0; blockIndex < anchors.length; blockIndex += 1) {
  const targetStart = anchors[blockIndex];
  const sourceStart = anchors[(blockIndex + 1) % anchors.length];
  for (let offset = 0; offset < blockSize; offset += 1) {
    replacementByTip.set(targetStart + offset, tips[sourceStart + blockSize - 1 - offset].label);
  }
}

let cursor = 0;
const pieces = [];
for (let tipIndex = 0; tipIndex < tips.length; tipIndex += 1) {
  const replacement = replacementByTip.get(tipIndex);
  if (!replacement) {
    continue;
  }
  const tip = tips[tipIndex];
  pieces.push(newick.slice(cursor, tip.start), replacement);
  cursor = tip.end;
}
pieces.push(newick.slice(cursor));
writeFileSync(outputPath, pieces.join(""), "utf8");

console.log(`Wrote ${outputPath}`);
console.log(`Reassigned ${replacementByTip.size.toLocaleString()} of ${tips.length.toLocaleString()} tip labels.`);
