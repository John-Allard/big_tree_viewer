import { Settings } from "lucide-react";
import { useState } from "react";
import { buildMetadataCladeRibbons, type CustomCladeRibbon } from "../lib/customCladeRibbons";
import type { TreeModel } from "../types/tree";
import "./cladeRibbonControls.css";

export default function CladeRibbonControls({ ribbons, onChange, comparisonActive, tree, isOpen: open, onToggle, columns = [], rows = [], keyColumn = "" }: {
  ribbons: CustomCladeRibbon[];
  onChange: (ribbons: CustomCladeRibbon[]) => void;
  comparisonActive: boolean;
  tree: TreeModel | null;
  isOpen: boolean;
  onToggle: () => void;
  columns?: string[];
  rows?: ReadonlyArray<Readonly<Record<string, string>>>;
  keyColumn?: string;
}) {
  const [mode, setMode] = useState<"nodes" | "tips">("nodes");
  const [column, setColumn] = useState("");
  const [width, setWidth] = useState(22);
  const [labelSize, setLabelSize] = useState(12);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const effectiveWidth = ribbons[0]?.widthPx ?? width;
  const effectiveSize = ribbons[0]?.labelSizePx ?? labelSize;
  const apply = () => {
    if (!tree) return;
    try {
      const next = buildMetadataCladeRibbons(tree, rows, keyColumn, column, mode);
      if (!next.length) throw new Error("No matching subtrees. Check the match column and ribbon label column.");
      const manual = ribbons.filter(ribbon => !ribbon.id.startsWith("metadata-ribbon:"));
      if (manual.length + next.length > 200) throw new Error("A tree can have up to 200 subtree ribbons.");
      onChange([...manual, ...next.map(ribbon => ({ ...ribbon, widthPx: effectiveWidth, labelSizePx: effectiveSize }))]);
      setError(""); setStatus(`Applied ${next.length} subtree ribbons.`);
    } catch (cause) { setStatus(""); setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="clade-ribbon-controls">
    <div className="metadata-toggle-row">
      <label className="metadata-inline-toggle metadata-toggle-main" title="Show ribbons outside taxonomy for selected subtrees.">
        <input type="checkbox" checked={ribbons.some(ribbon => ribbon.enabled)} disabled={!ribbons.length || comparisonActive}
          onChange={event => onChange(ribbons.map(ribbon => ({ ...ribbon, enabled: event.target.checked })))} />
        Show subtree ribbons
      </label>
      <div className="label-style-popover-anchor">
        <button type="button" className="label-style-gear" title="Subtree ribbons settings" aria-label="Subtree ribbons settings"
          aria-expanded={open} aria-haspopup="dialog" disabled={comparisonActive} onClick={onToggle}><Settings size={15} /></button>
        {open ? <div className="label-style-popover" role="dialog" aria-label="Subtree ribbons settings">
          <div className="label-style-popover-header"><strong>Subtree ribbons</strong>
            <button type="button" className="label-style-popover-close" aria-label="Close Subtree ribbons settings" onClick={onToggle}>x</button></div>
          <div className="label-style-body">
            <label>Ribbon thickness<input type="range" min={4} max={120} step={1} value={effectiveWidth}
              onChange={event => { const value = Number(event.target.value); setWidth(value); onChange(ribbons.map(ribbon => ({ ...ribbon, widthPx: value }))); }} /></label>
            <div className="figure-style-value">{effectiveWidth}px</div>
            <label title="Scale labels relative to their automatically fitted size. Labels always stay within their ribbon.">Ribbon label size<input type="range" min={5} max={48} step={1} value={effectiveSize}
              onChange={event => { const value = Number(event.target.value); setLabelSize(value); onChange(ribbons.map(ribbon => ({ ...ribbon, labelSizePx: value }))); }} /></label>
            <div className="figure-style-value">{Math.round(effectiveSize / 12 * 100)}%</div>
            {columns.length ? <>
              <label title="Match named internal nodes directly, or find maximal clades whose tips all share a metadata value.">Metadata ribbon matching
                <select aria-label="Metadata ribbon matching" value={mode} onChange={event => setMode(event.target.value as "nodes" | "tips")}>
                  <option value="nodes">Internal node names</option><option value="tips">Shared tip values</option>
                </select></label>
              <label>Ribbon label column<select aria-label="Ribbon label column" value={columns.includes(column) ? column : ""} onChange={event => setColumn(event.target.value)}>
                <option value="">Choose a column</option>{columns.filter(name => name !== keyColumn).map(name => <option key={name} value={name}>{name}</option>)}
              </select></label>
              <button type="button" className="secondary" disabled={!tree || !column || !keyColumn} onClick={apply}
                title="Create ribbons from the current metadata match column and selected label column. Replaces previously imported subtree ribbons; keeps manually added ribbons.">Apply metadata ribbons</button>
            </> : null}
            <div className="figure-style-value">{ribbons.length} subtree ribbons</div>
            {status ? <p className="status-line" role="status">{status}</p> : null}
            {error ? <p className="error" role="alert">{error}</p> : null}
          </div>
        </div> : null}
      </div>
    </div>
  </div>;
}
