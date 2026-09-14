import {test, expect} from '@playwright/test';
import {buildCache} from '../src/components/treeCanvasCache';
import {RectTreeIndex} from '../src/lib/rectTreeIndex';
import type {TreeModel, LayoutBuffers} from '../src/types/tree';
const layout = (center: number[], min: number[], max: number[]): LayoutBuffers => ({center: new Float64Array(center), min: new Float64Array(min), max: new Float64Array(max)});
// Non-ultrametric tree with a root after its descendants in the node arrays.
const tree: TreeModel = {
 root:4,nodeCount:5,leafCount:3,maxDepth:5,rootAge:10/3,isUltrametric:false,hasBranchLengths:true,
 branchLengthMinPositive:1,leafNodes:new Int32Array([0,2,3]),names:['A a','','B b','C c',''],
 nodeIntervalLower:new Float64Array(5),nodeIntervalUpper:new Float64Array(5),nodeIntervalCount:0,
 buffers:{parent:new Int32Array([1,4,1,4,-1]),firstChild:new Int32Array([-1,0,-1,-1,1]),nextSibling:new Int32Array([2,3,-1,-1,-1]),depth:new Float64Array([3,1,2,5,0]),branchLength:new Float64Array([2,1,1,5,0]),leafCount:new Int32Array([1,2,1,1,3])},
 layouts:{input:layout([0,.5,1,2,1.25],[0,0,1,2,0],[0,1,1,2,2]),desc:layout([0,.5,1,2,1.25],[0,0,1,2,0],[0,1,1,2,2]),asc:layout([1,1.5,2,0,.75],[1,1,2,0,0],[1,2,2,0,2])}
};
for(const order of ['input','asc','desc'] as const)test(`rectangular interval query matches complete geometry: ${order}`,()=>{
 const cache=buildCache(tree);const index=new RectTreeIndex(tree,d=>d);
 expect(cache.orderedLeaves[order]).toEqual([...tree.leafNodes].sort((a,b)=>tree.layouts[order].center[a]-tree.layouts[order].center[b]));
 for(const [minX,minY,maxX,maxY] of [[-1,-1,6,3],[.2,.4,2.1,.6],[1.8,.9,2.2,1.1],[2.9,-.01,3.1,.01],[7,0,8,2]]){
 const expected=cache.rectSegments[order].filter(s=>Math.max(s.x1,s.x2)>=minX&&Math.min(s.x1,s.x2)<=maxX&&Math.max(s.y1,s.y2)>=minY&&Math.min(s.y1,s.y2)<=maxY).map(s=>({...s,x1:Math.max(minX,Math.min(maxX,s.x1)),x2:Math.max(minX,Math.min(maxX,s.x2)),y1:Math.max(minY,Math.min(maxY,s.y1)),y2:Math.max(minY,Math.min(maxY,s.y2))}));
 const sort=(a: {node:number;kind:string},b:{node:number;kind:string})=>a.node-b.node||a.kind.localeCompare(b.kind);
 expect(index.query(tree.layouts[order],minX,minY,maxX,maxY).sort(sort)).toEqual(expected.sort(sort));
 }
});
test('subpixel aggregation preserves unequal branch extent and expands to exact topology',()=>{
 const index=new RectTreeIndex(tree,d=>d);
 const coarse=index.query(tree.layouts.input,-1,-1,6,3,3);
 expect(coarse).toHaveLength(1);expect(coarse[0].x2).toBe(5);
 const detail=index.query(tree.layouts.input,-1,-1,6,3,0);
 expect(detail).toHaveLength(buildCache(tree).rectSegments.input.length);
});
