export interface ImageContentBounds { x: number; y: number; width: number; height: number }

export function imageContentBounds(image: ImageData, padding = 8): ImageContentBounds {
  let left = image.width;
  let right = -1;
  let top = image.height;
  let bottom = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      if (image.data[offset + 3] === 0 || (
        Math.abs(image.data[offset] - 251) <= 2
        && Math.abs(image.data[offset + 1] - 252) <= 2
        && Math.abs(image.data[offset + 2] - 254) <= 2
      )) continue;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (right < left) return { x: 0, y: 0, width: image.width, height: image.height };
  left = Math.max(0, left - padding); top = Math.max(0, top - padding);
  right = Math.min(image.width - 1, right + padding); bottom = Math.min(image.height - 1, bottom + padding);
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
