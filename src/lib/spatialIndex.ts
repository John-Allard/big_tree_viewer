export interface IndexedSegment {
  node: number;
  kind: "stem" | "connector";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export class UniformGridIndex {
  private readonly width: number;
  private readonly height: number;
  private readonly minX: number;
  private readonly minY: number;
  private readonly cellWidth: number;
  private readonly cellHeight: number;
  private readonly cells: number[][];
  private readonly segments: IndexedSegment[];

  constructor(segments: IndexedSegment[], bounds: { minX: number; minY: number; maxX: number; maxY: number }) {
    this.segments = segments;
    const count = Math.max(1, segments.length);
    const target = Math.max(16, Math.min(256, Math.round(Math.sqrt(count / 4))));
    this.width = target;
    this.height = target;
    this.minX = bounds.minX;
    this.minY = bounds.minY;
    const spanX = Math.max(1e-9, bounds.maxX - bounds.minX);
    const spanY = Math.max(1e-9, bounds.maxY - bounds.minY);
    this.cellWidth = spanX / this.width;
    this.cellHeight = spanY / this.height;
    this.cells = Array.from({ length: this.width * this.height }, () => []);

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const minCellX = this.clampX(Math.floor((Math.min(segment.x1, segment.x2) - this.minX) / this.cellWidth));
      const maxCellX = this.clampX(Math.floor((Math.max(segment.x1, segment.x2) - this.minX) / this.cellWidth));
      const minCellY = this.clampY(Math.floor((Math.min(segment.y1, segment.y2) - this.minY) / this.cellHeight));
      const maxCellY = this.clampY(Math.floor((Math.max(segment.y1, segment.y2) - this.minY) / this.cellHeight));
      for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
        for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
          this.cells[cellY * this.width + cellX].push(index);
        }
      }
    }
  }

  query(x: number, y: number, radiusX: number, radiusY: number): IndexedSegment[] {
    const minCellX = this.clampX(Math.floor((x - radiusX - this.minX) / this.cellWidth));
    const maxCellX = this.clampX(Math.floor((x + radiusX - this.minX) / this.cellWidth));
    const minCellY = this.clampY(Math.floor((y - radiusY - this.minY) / this.cellHeight));
    const maxCellY = this.clampY(Math.floor((y + radiusY - this.minY) / this.cellHeight));
    const seen = new Set<number>();
    const hits: IndexedSegment[] = [];
    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        const cell = this.cells[cellY * this.width + cellX];
        for (let i = 0; i < cell.length; i += 1) {
          const segmentIndex = cell[i];
          if (seen.has(segmentIndex)) {
            continue;
          }
          seen.add(segmentIndex);
          hits.push(this.segments[segmentIndex]);
        }
      }
    }
    return hits;
  }

  private clampX(value: number): number {
    return Math.max(0, Math.min(this.width - 1, value));
  }

  private clampY(value: number): number {
    return Math.max(0, Math.min(this.height - 1, value));
  }
}

export function distanceToSegmentSquared(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) {
    const ddx = px - x1;
    const ddy = py - y1;
    return ddx * ddx + ddy * ddy;
  }
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  const ddx = px - cx;
  const ddy = py - cy;
  return ddx * ddx + ddy * ddy;
}
