export function exportSizeForViewport(
  viewport: { width: number; height: number },
  width: number,
): { width: number; height: number } {
  const scale = Math.min(
    Math.max(1, Number.isFinite(width) ? width : viewport.width) / Math.max(1, viewport.width),
    10000 / Math.max(1, viewport.width),
    10000 / Math.max(1, viewport.height),
  );
  return {
    width: Math.max(1, Math.round(viewport.width * scale)),
    height: Math.max(1, Math.round(viewport.height * scale)),
  };
}
