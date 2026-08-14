import type { TreeStatistics } from "../lib/treeStatistics";

function formatStatistic(value: number): string {
  if (!Number.isFinite(value)) {
    return "Not available";
  }
  if (Number.isInteger(value)) {
    return value.toLocaleString();
  }
  const absolute = Math.abs(value);
  if (absolute > 0 && (absolute < 0.001 || absolute >= 1_000_000)) {
    return value.toExponential(4);
  }
  return value.toLocaleString(undefined, { maximumSignificantDigits: 7 });
}

function StatisticRow({ label, value, title }: { label: string; value: string | number; title?: string }) {
  return (
    <>
      <dt title={title}>{label}</dt>
      <dd>{typeof value === "number" ? formatStatistic(value) : value}</dd>
    </>
  );
}

export default function TreeStatisticsView({ statistics }: { statistics: TreeStatistics }) {
  const binaryOnlyMessage = "Not available for a tree containing polytomies or unary nodes";
  return (
    <div className="tree-statistics">
      <h4>Structure</h4>
      <dl className="stats-list">
        <StatisticRow label="Tips" value={statistics.tipCount} />
        <StatisticRow label="Nodes" value={statistics.nodeCount} />
        <StatisticRow label="Internal nodes" value={statistics.internalNodeCount} />
        <StatisticRow label="Branches" value={statistics.branchCount} />
        <StatisticRow label="Bifurcations" value={statistics.bifurcatingNodeCount} />
        <StatisticRow label="Polytomies" value={statistics.polytomyCount} />
        <StatisticRow label="Unary nodes" value={statistics.unaryNodeCount} />
        <StatisticRow label="Maximum child count" value={statistics.maximumChildCount} />
        <StatisticRow label="Cherries" value={statistics.cherryCount} title="Internal nodes whose two children are tips." />
      </dl>

      <h4>Branch Lengths</h4>
      <dl className="stats-list">
        <StatisticRow label="Tree depth" value={statistics.maximumRootToTipDistance} title="Maximum distance from this tree or subtree root to a tip." />
        <StatisticRow label="Total branch length" value={statistics.totalBranchLength} />
        <StatisticRow label="Internal branch length" value={statistics.internalBranchLength} />
        <StatisticRow label="Terminal branch length" value={statistics.terminalBranchLength} />
        <StatisticRow label="Mean branch length" value={statistics.meanBranchLength} />
        <StatisticRow label="Minimum root-to-tip" value={statistics.minimumRootToTipDistance} />
        <StatisticRow label="Mean root-to-tip" value={statistics.meanRootToTipDistance} />
        <StatisticRow label="Maximum root-to-tip" value={statistics.maximumRootToTipDistance} />
        <StatisticRow label="Root-to-tip range" value={statistics.rootToTipDistanceRange} />
        <StatisticRow
          label="Ultrametric"
          value={statistics.ultrametric ? "Yes" : "No"}
          title="Root-to-tip distances are treated as equal within 0.5% of tree depth."
        />
        <StatisticRow
          label="Mean pairwise tip distance"
          value={statistics.meanPairwiseTipDistance ?? "Not available"}
          title="Mean patristic distance over all pairs of tips."
        />
        <StatisticRow label="Zero-length branches" value={statistics.zeroLengthBranchCount} />
        <StatisticRow label="Negative-length branches" value={statistics.negativeBranchCount} />
      </dl>

      <h4>Shape And Balance</h4>
      <dl className="stats-list">
        <StatisticRow label="Mean tip depth" value={statistics.meanTopologicalTipDepth} title="Mean number of branches from the root to a tip." />
        <StatisticRow label="Maximum tip depth" value={statistics.maximumTopologicalTipDepth} />
        <StatisticRow label="Sackin index" value={statistics.sackinIndex} title="Sum of the topological depths of all tips." />
        <StatisticRow
          label="Normalized Sackin"
          value={statistics.normalizedSackinIndex ?? binaryOnlyMessage}
          title="Sackin index scaled between the most balanced and maximally unbalanced binary trees of this size."
        />
        <StatisticRow
          label="Colless index"
          value={statistics.collessIndex ?? binaryOnlyMessage}
          title="Sum of the difference in descendant tip counts between the two children of every internal node."
        />
        <StatisticRow
          label="Normalized Colless"
          value={statistics.normalizedCollessIndex ?? binaryOnlyMessage}
          title="Colless index divided by its maximum for a rooted binary tree of this size."
        />
      </dl>
    </div>
  );
}
