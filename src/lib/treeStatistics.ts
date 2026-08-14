import type { TreeModel } from "../types/tree";

export interface TreeStatistics {
  rootNode: number;
  tipCount: number;
  nodeCount: number;
  internalNodeCount: number;
  branchCount: number;
  bifurcatingNodeCount: number;
  polytomyCount: number;
  unaryNodeCount: number;
  maximumChildCount: number;
  cherryCount: number;
  totalBranchLength: number;
  internalBranchLength: number;
  terminalBranchLength: number;
  meanBranchLength: number;
  zeroLengthBranchCount: number;
  negativeBranchCount: number;
  minimumRootToTipDistance: number;
  meanRootToTipDistance: number;
  maximumRootToTipDistance: number;
  rootToTipDistanceRange: number;
  ultrametric: boolean;
  meanPairwiseTipDistance: number | null;
  meanTopologicalTipDepth: number;
  maximumTopologicalTipDepth: number;
  sackinIndex: number;
  normalizedSackinIndex: number | null;
  collessIndex: number | null;
  normalizedCollessIndex: number | null;
  strictlyBifurcating: boolean;
}

function normalizedBinarySackinIndex(tipCount: number, sackinIndex: number): number | null {
  if (tipCount < 2) {
    return null;
  }
  const floorLog2 = Math.floor(Math.log2(tipCount));
  const minimum = (tipCount * (floorLog2 + 2)) - (2 ** (floorLog2 + 1));
  const maximum = ((tipCount * (tipCount + 1)) / 2) - 1;
  if (maximum <= minimum) {
    return 0;
  }
  return Math.max(0, Math.min(1, (sackinIndex - minimum) / (maximum - minimum)));
}

export function computeTreeStatistics(tree: TreeModel, rootNode = tree.root): TreeStatistics {
  if (rootNode < 0 || rootNode >= tree.nodeCount) {
    throw new RangeError(`Tree statistics root node ${rootNode} is outside the tree.`);
  }

  const { branchLength, depth, firstChild, leafCount, nextSibling } = tree.buffers;
  const tipCount = Math.max(1, leafCount[rootNode]);
  const rootDepth = depth[rootNode];
  const nodeStack: number[] = [rootNode];
  const topologicalDepthStack: number[] = [0];

  let nodeCount = 0;
  let internalNodeCount = 0;
  let bifurcatingNodeCount = 0;
  let polytomyCount = 0;
  let unaryNodeCount = 0;
  let maximumChildCount = 0;
  let cherryCount = 0;
  let totalBranchLength = 0;
  let internalBranchLength = 0;
  let terminalBranchLength = 0;
  let zeroLengthBranchCount = 0;
  let negativeBranchCount = 0;
  let rootToTipTotal = 0;
  let minimumRootToTipDistance = Number.POSITIVE_INFINITY;
  let maximumRootToTipDistance = Number.NEGATIVE_INFINITY;
  let topologicalTipDepthTotal = 0;
  let maximumTopologicalTipDepth = 0;
  let collessIndex = 0;
  let pairwiseDistanceTotal = 0;

  while (nodeStack.length > 0) {
    const node = nodeStack.pop()!;
    const topologicalDepth = topologicalDepthStack.pop()!;
    nodeCount += 1;

    if (node !== rootNode) {
      const length = Number.isFinite(branchLength[node]) ? branchLength[node] : 0;
      totalBranchLength += length;
      if (length === 0) {
        zeroLengthBranchCount += 1;
      } else if (length < 0) {
        negativeBranchCount += 1;
      }
      if (firstChild[node] < 0) {
        terminalBranchLength += length;
      } else {
        internalBranchLength += length;
      }
      const descendantTips = leafCount[node];
      pairwiseDistanceTotal += length * descendantTips * (tipCount - descendantTips);
    }

    if (firstChild[node] < 0) {
      const rootToTipDistance = depth[node] - rootDepth;
      rootToTipTotal += rootToTipDistance;
      minimumRootToTipDistance = Math.min(minimumRootToTipDistance, rootToTipDistance);
      maximumRootToTipDistance = Math.max(maximumRootToTipDistance, rootToTipDistance);
      topologicalTipDepthTotal += topologicalDepth;
      maximumTopologicalTipDepth = Math.max(maximumTopologicalTipDepth, topologicalDepth);
      continue;
    }

    internalNodeCount += 1;
    let childCount = 0;
    let tipChildCount = 0;
    let firstChildTipCount = 0;
    let secondChildTipCount = 0;
    for (let child = firstChild[node]; child >= 0; child = nextSibling[child]) {
      childCount += 1;
      if (childCount === 1) {
        firstChildTipCount = leafCount[child];
      } else if (childCount === 2) {
        secondChildTipCount = leafCount[child];
      }
      if (firstChild[child] < 0) {
        tipChildCount += 1;
      }
      nodeStack.push(child);
      topologicalDepthStack.push(topologicalDepth + 1);
    }
    maximumChildCount = Math.max(maximumChildCount, childCount);
    if (childCount === 2) {
      bifurcatingNodeCount += 1;
      collessIndex += Math.abs(firstChildTipCount - secondChildTipCount);
      if (tipChildCount === 2) {
        cherryCount += 1;
      }
    } else if (childCount > 2) {
      polytomyCount += 1;
    } else {
      unaryNodeCount += 1;
    }
  }

  const branchCount = Math.max(0, nodeCount - 1);
  const strictlyBifurcating = tipCount > 1
    && internalNodeCount > 0
    && bifurcatingNodeCount === internalNodeCount;
  const sackinIndex = topologicalTipDepthTotal;
  const maximumColless = ((tipCount - 1) * (tipCount - 2)) / 2;
  const finiteMinimumRootToTipDistance = Number.isFinite(minimumRootToTipDistance) ? minimumRootToTipDistance : 0;
  const finiteMaximumRootToTipDistance = Number.isFinite(maximumRootToTipDistance) ? maximumRootToTipDistance : 0;
  const rootToTipDistanceRange = finiteMaximumRootToTipDistance - finiteMinimumRootToTipDistance;
  const ultrametricTolerance = Math.max(1e-6, Math.abs(finiteMaximumRootToTipDistance) * 0.005);

  return {
    rootNode,
    tipCount,
    nodeCount,
    internalNodeCount,
    branchCount,
    bifurcatingNodeCount,
    polytomyCount,
    unaryNodeCount,
    maximumChildCount,
    cherryCount,
    totalBranchLength,
    internalBranchLength,
    terminalBranchLength,
    meanBranchLength: branchCount > 0 ? totalBranchLength / branchCount : 0,
    zeroLengthBranchCount,
    negativeBranchCount,
    minimumRootToTipDistance: finiteMinimumRootToTipDistance,
    meanRootToTipDistance: tipCount > 0 ? rootToTipTotal / tipCount : 0,
    maximumRootToTipDistance: finiteMaximumRootToTipDistance,
    rootToTipDistanceRange,
    ultrametric: rootToTipDistanceRange <= ultrametricTolerance,
    meanPairwiseTipDistance: tipCount > 1
      ? pairwiseDistanceTotal / ((tipCount * (tipCount - 1)) / 2)
      : null,
    meanTopologicalTipDepth: tipCount > 0 ? topologicalTipDepthTotal / tipCount : 0,
    maximumTopologicalTipDepth,
    sackinIndex,
    normalizedSackinIndex: strictlyBifurcating
      ? normalizedBinarySackinIndex(tipCount, sackinIndex)
      : null,
    collessIndex: strictlyBifurcating ? collessIndex : null,
    normalizedCollessIndex: strictlyBifurcating
      ? maximumColless > 0 ? collessIndex / maximumColless : 0
      : null,
    strictlyBifurcating,
  };
}
