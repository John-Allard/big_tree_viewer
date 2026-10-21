// PNG's standard sRGB chunk (perceptual intent), including its CRC.
const SRGB_CHUNK = new Uint8Array([
  0, 0, 0, 1, 115, 82, 71, 66, 0, 174, 206, 28, 233,
]);

function resolutionChunk(dpi: number): Uint8Array<ArrayBuffer> {
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([112, 72, 89, 115], 4); // pHYs
  const pixelsPerMetre = Math.round(dpi / 0.0254);
  view.setUint32(8, pixelsPerMetre);
  view.setUint32(12, pixelsPerMetre);
  chunk[16] = 1;
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, 17)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  view.setUint32(17, (crc ^ 0xffffffff) >>> 0);
  return chunk;
}

export async function tagPngAsSrgb(blob: Blob, dpi?: number): Promise<Blob> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) {
    return blob;
  }
  const view = new DataView(bytes.buffer);
  const resolution = dpi && Number.isFinite(dpi) && dpi > 0 ? resolutionChunk(dpi) : null;
  const parts: BlobPart[] = [blob.slice(0, 8)];
  let hasColorProfile = false;
  let insertedTags = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    const end = offset + length + 12;
    if (end > bytes.length) return blob;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === "sRGB" || type === "iCCP") {
      hasColorProfile = true;
    }
    if (type === "IDAT" && !insertedTags) {
      // Preserve compressed pixels; replace only the requested image metadata.
      if (!hasColorProfile) parts.push(SRGB_CHUNK);
      if (resolution) parts.push(resolution);
      insertedTags = true;
    }
    if (type !== "pHYs" || !resolution) parts.push(blob.slice(offset, end));
    offset = end;
  }
  return insertedTags ? new Blob(parts, { type: "image/png" }) : blob;
}
