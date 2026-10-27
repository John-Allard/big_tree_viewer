import { expect, test } from "@playwright/test";
import { automaticPolarBranchLabelCandidates, arcIntersectsLabel, branchIntersectsLabel, labelFitsBranch } from "../src/lib/automaticBranchLabel";

test("automatic labels fit stems or clear both crossbar and parent stem", () => {
  expect(labelFitsBranch(109, 100)).toBe(false);
  expect(labelFitsBranch(110, 100)).toBe(true);
  for (const theta of [0, .7, 2, 3.5, 5]) {
    for (const nodeRadius of [120, 400]) {
      const p = automaticPolarBranchLabelCandidates(20, 30, 100, nodeRadius, theta, 100, 12)[0];
      const radial = (p.x-20)*Math.cos(theta)+(p.y-30)*Math.sin(theta);
      const tangent = -(p.x-20)*Math.sin(theta)+(p.y-30)*Math.cos(theta);
      expect(Math.abs(p.rotation)).toBeLessThanOrEqual(Math.PI/2);
      if (nodeRadius === 400) {
        expect(p.alongBranch).toBe(true);
        expect(radial).toBeCloseTo(250);
        expect(tangent-6).toBeCloseTo(5);
      } else {
        expect(p.alongBranch).toBe(false);
        // Every corner must lie inside the curved crossbar and beside its stem.
        for (const x of [-50,50]) for (const y of [-6,6]) {
          const dx = p.x-20+x*Math.cos(p.rotation)-y*Math.sin(p.rotation);
          const dy = p.y-30+x*Math.sin(p.rotation)+y*Math.cos(p.rotation);
          expect(Math.hypot(dx,dy)).toBeLessThanOrEqual(nodeRadius-5+1e-8);
          expect(-dx*Math.sin(theta)+dy*Math.cos(theta)).toBeGreaterThanOrEqual(5-1e-8);
        }
        expect(branchIntersectsLabel(p,100,12,20+100*Math.cos(theta),30+100*Math.sin(theta),20+120*Math.cos(theta),30+120*Math.sin(theta))).toBe(false);
      }
    }
  }
});
for (const viewMode of ["rectangular", "circular", "fan"] as const) {
 test(`automatic label placement and export in ${viewMode}`, async ({ page }) => {
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.evaluate(viewMode => window.postMessage({type:"big-tree-viewer:load",payload:{
    newick:"(((A:1,B:1)long:5,(C:1,D:1)short:0.02)ancestor:3);",
    metadata:{text:"id,label\nlong,Long branch\nshort,Short branch\n",keyColumn:"id",enabled:true,labelsEnabled:true,labelColumn:"label"},
    visual:{viewMode,showTipLabels:false,showGenusLabels:false,metadataLegendEnabled:false,
      metadataLabelMinSpacingPx:0,figureStyles:{internalNode:{metadataPlacement:"auto"}}},
  }},"*"),viewMode);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataLabeledNodeCount === 2);
  const result = await page.evaluate(() => new Promise<string>(resolve => {
    const listener=(event:MessageEvent)=>{if(event.data?.type==="big-tree-viewer:exported"){window.removeEventListener("message",listener);resolve(event.data.text);}};
    window.addEventListener("message",listener);
    window.postMessage({type:"big-tree-viewer:export",payload:{format:"svg",delivery:"postMessage"}},"*");
  }));
  const texts = await page.evaluate(svg => [...new DOMParser().parseFromString(svg,"image/svg+xml").querySelectorAll("text")].filter(t => t.textContent?.includes("branch")).map(t=>({text:t.textContent,x:Number(t.getAttribute("x")),y:Number(t.getAttribute("y")),transform:t.getAttribute("transform")})),result);
  expect(texts).toHaveLength(2);
  // Verify actual glyph boxes against exported branch paths, including rotations.
  const overlaps = await page.evaluate(svg => {
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:-10000px;top:0";
    host.innerHTML = svg; document.body.appendChild(host);
    const points: DOMPoint[] = [];
    for (const path of host.querySelectorAll<SVGGeometryElement>("line,path")) {
      if (!path.getAttribute("stroke") || path.getAttribute("stroke") === "none") continue;
      const length = path.getTotalLength(), steps = Math.ceil(length / .5);
      for (let i=0;i<=steps;i++) { const p=path.getPointAtLength(length*i/Math.max(1,steps)); points.push(new DOMPoint(p.x,p.y)); }
    }
    const overlaps = [...host.querySelectorAll("text")].filter(t=>t.textContent?.includes("branch")).filter(text => {
      const box=text.getBBox(), inverse=text.getCTM()!.inverse();
      return points.some(point => {const p=point.matrixTransform(inverse);return p.x>box.x-1&&p.x<box.x+box.width+1&&p.y>box.y-1&&p.y<box.y+box.height+1;});
    }).map(t=>t.textContent);
    host.remove(); return overlaps;
  }, result);
  expect(overlaps).toEqual([]);
  const short = texts.find(t => t.text === "Short branch")!;
  const stem = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getBranchScreenSegmentForTest(5));
  expect(stem).toBeTruthy();
  if(viewMode === "rectangular") {
    expect(short.x).toBeGreaterThan(stem!.x2);
    expect(short.y).toBeLessThan(stem!.y2);
  }
  const shared=await page.evaluate(()=>window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildSharedSubtreePayloadForTest(1));
  expect(shared?.visual?.figureStyles?.internalNode?.metadataPlacement).toBe("auto");
  await page.screenshot({path:`/tmp/btv-auto-label-${viewMode}.png`});
 });
}

test("arc collision checks use the curved crossbar rather than its chord", () => {
 const label={x:0,y:100,rotation:0};
 expect(arcIntersectsLabel(label,20,10,0,0,100,0,Math.PI)).toBe(true);
 expect(arcIntersectsLabel(label,20,10,0,0,100,Math.PI,2*Math.PI)).toBe(false);
 expect(arcIntersectsLabel({...label,y:80},20,10,0,0,100,0,Math.PI)).toBe(false);
 expect(branchIntersectsLabel(label,20,10,-100,0,100,0)).toBe(false);
});
