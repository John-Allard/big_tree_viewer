import { ChevronRight, Trash2 } from "lucide-react";
import type { RefObject } from "react";
import type { CustomCladeRibbon } from "../lib/customCladeRibbons";
import "./cladeRibbonControls.css";

export default function CladeRibbonControls({ ribbons, onChange, detailsRef, comparisonActive }: {
  ribbons: CustomCladeRibbon[];
  onChange: (ribbons: CustomCladeRibbon[]) => void;
  detailsRef: RefObject<HTMLDetailsElement | null>;
  comparisonActive: boolean;
}) {
  const update = (id: string, patch: Partial<CustomCladeRibbon>) => {
    onChange(ribbons.map(ribbon => ribbon.id === id ? { ...ribbon, ...patch } : ribbon));
  };
  return (
    <details ref={detailsRef} className="clade-ribbon-controls">
      <summary title="Independent ribbons for descendants of an internal node. Use Add Clade Ribbon in the node's context menu.">
        <ChevronRight className="clade-ribbon-chevron" size={12} aria-hidden="true" />
        Clade ribbons{ribbons.length > 0 ? ` (${ribbons.length})` : ""}
      </summary>
      {comparisonActive ? <p className="status-line">Clade ribbons are hidden during tree comparison.</p> : null}
      {ribbons.length === 0 ? <p className="empty-note">No clade ribbons.</p> : null}
      {ribbons.map(ribbon => (
        <div key={ribbon.id} className="clade-ribbon-item">
          <div className="clade-ribbon-name-row">
            <input type="checkbox" aria-label={`Show ribbon ${ribbon.id}`} checked={ribbon.enabled}
              title="Show or hide this clade ribbon" onChange={event => update(ribbon.id, { enabled: event.target.checked })} />
            <input type="text" id={`clade-ribbon-label-${ribbon.id}`} aria-label={`Ribbon label ${ribbon.id}`}
              value={ribbon.label} maxLength={256} onChange={event => update(ribbon.id, { label: event.target.value })} />
            <button type="button" className="secondary" aria-label={`Remove ribbon ${ribbon.id}`} title="Remove this clade ribbon"
              onClick={() => onChange(ribbons.filter(item => item.id !== ribbon.id))}><Trash2 size={15} aria-hidden="true" /></button>
          </div>
          <div className="clade-ribbon-style-row">
            <input type="color" aria-label={`Ribbon color ${ribbon.id}`} title="Ribbon color" value={ribbon.color}
              onChange={event => update(ribbon.id, { color: event.target.value })} />
            <select aria-label={`Ribbon placement ${ribbon.id}`} value={ribbon.placement}
              title="Place this ribbon inside or outside the mapped taxonomy ribbons"
              onChange={event => update(ribbon.id, { placement: event.target.value as CustomCladeRibbon["placement"] })}>
              <option value="outside">Outside taxonomy</option>
              <option value="inside">Inside taxonomy</option>
            </select>
          </div>
        </div>
      ))}
    </details>
  );
}
