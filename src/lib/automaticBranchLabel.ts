/** Screen-space geometry: reserve padding at both ends of the incoming stem. */
export function labelFitsBranch(length: number, width: number): boolean {
  return length >= width + 10;
}
export interface BranchLabelPlacement {
  x: number; y: number; rotation: number; alongBranch: boolean;
}
function upright(angle: number): number {
  let rotation = Math.atan2(Math.sin(angle), Math.cos(angle));
  if (rotation > Math.PI / 2) rotation -= Math.PI;
  if (rotation < -Math.PI / 2) rotation += Math.PI;
  return rotation;
}
/** Candidates stay attached to the incoming stem or the inner face of its
 * crossbar. Both sides are considered; callers reject surrounding branches. */
export function automaticPolarBranchLabelCandidates(
  centerX: number, centerY: number, parentRadius: number, nodeRadius: number,
  theta: number, width: number, height: number,
): BranchLabelPlacement[] {
  const candidates: BranchLabelPlacement[] = [];
  if (labelFitsBranch(Math.abs(nodeRadius - parentRadius), width)) {
    for (const side of [1, -1]) {
      const radius = (parentRadius + nodeRadius) / 2;
      const gap = side * (height / 2 + 5);
      candidates.push({
        x: centerX + radius * Math.cos(theta) - gap * Math.sin(theta),
        y: centerY + radius * Math.sin(theta) + gap * Math.cos(theta),
        rotation: upright(theta), alongBranch: true,
      });
    }
  }
  // Account for the corners of the entire text box, not just its anchor.
  const outerRadius = nodeRadius - 5;
  if (outerRadius > width / 2) {
    const radius = Math.sqrt(outerRadius ** 2 - (width / 2) ** 2) - height / 2;
    if (radius > height / 2) {
      const inner = radius - height / 2;
      const delta = Math.atan2(width / 2, inner) + Math.asin(Math.min(1, 5 / Math.hypot(inner, width / 2)));
      for (const side of [1, -1]) {
        const angle = theta + side * delta;
        candidates.push({x: centerX + radius * Math.cos(angle), y: centerY + radius * Math.sin(angle),
          rotation: upright(angle + Math.PI / 2), alongBranch: false});
      }
    }
  }
  // If the inner face is crowded by a neighboring ancestral branch, also
  // consider the outer face. The caller still checks all outgoing stems.
  const outer = nodeRadius + height / 2 + 5;
  const inner = outer - height / 2;
  const delta = Math.atan2(width / 2, inner) + Math.asin(Math.min(1, 5 / Math.hypot(inner, width / 2)));
  for (const side of [1, -1]) {
    const angle = theta + side * delta;
    candidates.push({x: centerX + outer * Math.cos(angle), y: centerY + outer * Math.sin(angle),
      rotation: upright(angle + Math.PI / 2), alongBranch: false});
  }
  return candidates;
}

/** Exact segment/rotated-text-box intersection (with caller-supplied padding). */
export function branchIntersectsLabel(
  label: Pick<BranchLabelPlacement, "x" | "y" | "rotation">, width: number, height: number,
  x1: number, y1: number, x2: number, y2: number, padding = 2,
): boolean {
  const c = Math.cos(label.rotation), s = Math.sin(label.rotation);
  const ax = (x1-label.x)*c+(y1-label.y)*s, ay = -(x1-label.x)*s+(y1-label.y)*c;
  const bx = (x2-label.x)*c+(y2-label.y)*s, by = -(x2-label.x)*s+(y2-label.y)*c;
  const halfW = width/2+padding, halfH = height/2+padding;
  let lo = 0, hi = 1;
  for (const [start, delta, half] of [[ax,bx-ax,halfW],[ay,by-ay,halfH]]) {
    if (Math.abs(delta) < 1e-12) { if (Math.abs(start) > half) return false; }
    else {
      const t1 = (-half-start)/delta, t2 = (half-start)/delta;
      lo = Math.max(lo, Math.min(t1,t2)); hi = Math.min(hi, Math.max(t1,t2));
      if (lo > hi) return false;
    }
  }
  return true;
}

/** Exact arc/text intersection, avoiding chord approximations at high zoom. */
export function arcIntersectsLabel(
  label: Pick<BranchLabelPlacement, "x" | "y" | "rotation">, width: number, height: number,
  centerX: number, centerY: number, radius: number, start: number, end: number, padding = 2,
): boolean {
  const c=Math.cos(label.rotation), s=Math.sin(label.rotation);
  const cx=(centerX-label.x)*c+(centerY-label.y)*s;
  const cy=-(centerX-label.x)*s+(centerY-label.y)*c;
  const hw=width/2+padding, hh=height/2+padding;
  const inside=(x:number,y:number)=>Math.abs(x)<=hw&&Math.abs(y)<=hh;
  for(const angle of [start,end]) {
    if(inside(cx+radius*Math.cos(angle-label.rotation),cy+radius*Math.sin(angle-label.rotation))) return true;
  }
  const onArc=(x:number,y:number)=>{
    const angle=Math.atan2(y-cy,x-cx)+label.rotation;
    const offset=((angle-start)%(2*Math.PI)+2*Math.PI)%(2*Math.PI);
    return offset<=end-start+1e-9;
  };
  for(const x of [-hw,hw]) {
    const square=radius*radius-(x-cx)**2;
    if(square<0) continue;
    for(const y of [cy-Math.sqrt(square),cy+Math.sqrt(square)]) if(inside(x,y)&&onArc(x,y)) return true;
  }
  for(const y of [-hh,hh]) {
    const square=radius*radius-(y-cy)**2;
    if(square<0) continue;
    for(const x of [cx-Math.sqrt(square),cx+Math.sqrt(square)]) if(inside(x,y)&&onArc(x,y)) return true;
  }
  return false;
}
