import { expect, test, type Page } from "@playwright/test";
import { circularLabelOffset, normalizeLabelAngle } from "../src/lib/circularLabelOffsets";
import { readFile } from "node:fs/promises";
import { gunzipSync, strFromU8 } from "fflate";
async function exportedSvg(page: Page) {
  const svg = await page.evaluate(() => new Promise<string>(resolve => {
    const listener = (e: MessageEvent) => { if (e.data?.type === "big-tree-viewer:exported") { window.removeEventListener("message", listener); resolve(e.data.text); } };
    window.addEventListener("message", listener);
    window.postMessage({type:"big-tree-viewer:export",payload:{format:"svg",delivery:"postMessage"}},"*");
  }));
  return svg;
}
async function geometry(page: Page) {
  return page.evaluate(svg => [...new DOMParser().parseFromString(svg,"image/svg+xml").querySelectorAll("path,line,rect,circle,polygon")].map(e=>e.outerHTML),await exportedSvg(page));
}
async function labels(page: Page) {
  const svg=await exportedSvg(page);
  return page.evaluate(svg => [...new DOMParser().parseFromString(svg,"image/svg+xml").querySelectorAll("text")]
    .filter(t => t.textContent?.startsWith("AQP")).map(t => ({text:t.textContent,fill:t.getAttribute("fill"),x:Number(t.getAttribute("x")),y:Number(t.getAttribute("y")),anchor:t.getAttribute("text-anchor")})),svg);
}
async function panel(page: Page,name:string) { const p=page.locator(".panel-section .section-toggle").filter({hasText:name}).first();if(await p.getAttribute("aria-expanded")!=="true")await p.click(); }
for (const viewMode of ["rectangular","circular","fan"] as const) {
 test(`selected internal metadata labels follow incoming branches and their colors in ${viewMode}`,async({page})=>{
  await page.goto("/?btv_api=1");await page.waitForFunction(()=>Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.evaluate(viewMode=>window.postMessage({type:"big-tree-viewer:load",payload:{
   newick:"((A:1,B:1)nodeA:3,(C:1,D:1)nodeB:3);",
   metadata:{text:"id,label,group\nnodeA,AQP0,alpha\nnodeB,AQP1,beta\nA,,alpha\nB,,alpha\nC,,beta\nD,,beta\n",keyColumn:"id",enabled:true,valueColumn:"group",colorMode:"categorical",applyScope:"subtree",labelsEnabled:true,labelColumn:"label"},
   visual:{viewMode,circularRotationDegrees:35,showTipLabels:false,showGenusLabels:false,showInternalNodeLabels:false,metadataLegendEnabled:false,metadataCategoryColorOverrides:{alpha:"#004488",beta:"#bb5566"},metadataLabelMinSpacingPx:0,
    figureStyles:{internalNode:{metadataPlacement:"stem",metadataColorMode:"branch",polarOrientation:"radial"}}},
  }},"*"),viewMode);
  await page.waitForFunction(()=>window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataLabeledNodeCount===2);
  const labeledGeometry=await geometry(page);
  const before=await labels(page);expect(before).toHaveLength(2);expect(before.map(t=>t.fill).sort()).toEqual(["#004488","#bb5566"]);expect(before.every(t=>t.anchor==="middle")).toBe(true);
  const stem=await page.evaluate(()=>window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getBranchScreenSegmentForTest(1));expect(stem).toBeTruthy();const label=before.find(t=>t.text==="AQP0")!;
  if(viewMode==="rectangular")expect(label.x).toBeCloseTo((stem!.x1+stem!.x2)/2,2);
  else{const camera=await page.evaluate(()=>window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera());expect(Math.hypot(label.x-camera!.translateX,label.y-camera!.translateY)).toBeCloseTo(Math.hypot((stem!.x1+stem!.x2)/2-camera!.translateX,(stem!.y1+stem!.y2)/2-camera!.translateY),2);}
  await panel(page,"Metadata");await page.getByRole("button",{name:"Metadata text labels settings",exact:true}).click();const dialog=page.getByRole("dialog",{name:"Metadata text labels settings",exact:true});await expect(dialog.getByRole("combobox",{name:"Label placement",exact:true})).toHaveValue("stem");
  await dialog.getByRole("combobox",{name:"Label color",exact:true}).selectOption("fixed");await dialog.getByLabel("Fixed label color",{exact:true}).fill("#123abc");expect((await labels(page)).map(t=>t.fill)).toEqual(["#123abc","#123abc"]);
  if(viewMode!=="rectangular"){
   const camera=await page.evaluate(()=>window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera());
   for(const placement of ["stem","node"]){
    await dialog.getByRole("combobox",{name:"Label placement",exact:true}).selectOption(placement);
    for(const oldName of ["Metadata label X offset","Metadata label Y offset","Metadata label tangential offset"]){
     await expect(dialog.getByRole("slider",{name:oldName,exact:true})).toHaveCount(0);
    }
    for(const axis of ["radial","angular"]){
     const originalPosition=(await labels(page)).find(t=>t.text==="AQP0")!;
     const offset=dialog.getByRole("slider",{name:`Metadata label ${axis} offset`,exact:true});
     const previous=Number(await offset.inputValue());await offset.focus();await offset.press("ArrowRight");await expect(offset).toHaveValue(String(previous+(axis==="angular"?.5:1)));
     const moved=(await labels(page)).find(t=>t.text==="AQP0")!;
     const x=originalPosition.x-camera!.translateX,y=originalPosition.y-camera!.translateY;
     const nx=moved.x-camera!.translateX,ny=moved.y-camera!.translateY;
     const radius=Math.hypot(x,y),newRadius=Math.hypot(nx,ny);
     const degrees=Math.atan2(x*ny-y*nx,x*nx+y*ny)*180/Math.PI;
     expect(newRadius-radius).toBeCloseTo(axis==="radial"?1:0,2);
     expect(degrees).toBeCloseTo(axis==="angular"?.5:0,2);
     if(axis==="angular"){await expect(offset).toHaveAttribute("min","-180");await expect(offset).toHaveAttribute("max","180");}
    }
   }
   await dialog.getByRole("combobox",{name:"Label placement",exact:true}).selectOption("stem");
  }else{
   await expect(dialog.getByRole("slider",{name:"Metadata label X offset",exact:true})).toBeVisible();
   await expect(dialog.getByRole("slider",{name:"Metadata label Y offset",exact:true})).toBeVisible();
  }
  const branch=await page.evaluate(()=>window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCurrentBranchColors());expect(branch?.[1]).toBe("#004488");
  await page.getByRole("button",{name:"Close Metadata text labels settings",exact:true}).click();await page.evaluate(()=>Object.defineProperty(window,"showSaveFilePicker",{value:undefined,configurable:true}));const saving=page.waitForEvent("download");await page.getByRole("button",{name:"Save Session",exact:true}).click();const saved=JSON.parse(strFromU8(gunzipSync(await readFile((await(await saving).path())!))));expect(saved.settings.figureStyles.internalNode).toMatchObject({metadataPlacement:"stem",metadataColorMode:"fixed",metadataColor:"#123abc"});expect(saved.settings.figureStyles.internalNode.metadataAngularOffsetDegrees ?? 0).toBe(viewMode==="rectangular"?0:1);expect(saved.tree.newick).toContain("nodeA");
  const shared=await page.evaluate(()=>window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildSharedSubtreePayloadForTest(1));expect(shared?.visual?.figureStyles?.internalNode).toMatchObject({metadataPlacement:"stem",metadataColorMode:"fixed",metadataColor:"#123abc"});
  await page.getByLabel("Show metadata text labels",{exact:true}).uncheck();
  expect(await geometry(page)).toEqual(labeledGeometry); // Labels must never add connector lines or other geometry.

 });
}
test("saved radial offsets outside the old slider range do not snap when adjusted",async({page})=>{
 await page.goto("/?btv_api=1");await page.waitForFunction(()=>Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));await page.evaluate(()=>window.postMessage({type:"big-tree-viewer:load",payload:{newick:"((A:1,B:1)Named:2,C:3);",visual:{viewMode:"circular",showInternalNodeLabels:true,figureStyles:{internalNode:{offsetYPx:-50}}}}},"*"));await page.waitForFunction(()=>window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);await panel(page,"Visual Options");await page.getByRole("button",{name:"Internal node labels settings",exact:true}).click();const slider=page.getByRole("slider",{name:"Radial offset",exact:true});await expect(slider).toHaveValue("-50");await slider.focus();await slider.press("ArrowLeft");await expect(slider).toHaveValue("-51");await expect(page.getByRole("dialog",{name:"Internal node labels settings",exact:true})).toContainText("-51px");
});

test("angular offsets preserve radius and wrap full turns",()=>{
 expect(normalizeLabelAngle(720)).toBe(0);expect(normalizeLabelAngle(361)).toBe(1);expect(normalizeLabelAngle(-361)).toBe(-1);
 const quarter=circularLabelOffset(110,20,10,20,0,90,0);expect(quarter.x).toBeCloseTo(10);expect(quarter.y).toBeCloseTo(120);
 const p=circularLabelOffset(110,20,10,20,0,450,5);expect(p.x).toBeCloseTo(10);expect(p.y).toBeCloseTo(125);
});
