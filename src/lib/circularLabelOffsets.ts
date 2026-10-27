/** Keep angular controls within one turn without clamping an equivalent angle. */
export function normalizeLabelAngle(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  if (degrees >= -180 && degrees <= 180) return degrees;
  return ((degrees + 180) % 360 + 360) % 360 - 180;
}

/** Rotate a label around the tree origin, then change its radial distance. */
export function circularLabelOffset(
  x: number, y: number, centerX: number, centerY: number,
  theta: number, angularDegrees: number, radialPixels: number,
): { x: number; y: number } {
  const angle = normalizeLabelAngle(angularDegrees) * Math.PI / 180;
  const dx = x - centerX, dy = y - centerY;
  return {
    x: centerX + dx * Math.cos(angle) - dy * Math.sin(angle) + radialPixels * Math.cos(theta + angle),
    y: centerY + dx * Math.sin(angle) + dy * Math.cos(angle) + radialPixels * Math.sin(theta + angle),
  };
}
