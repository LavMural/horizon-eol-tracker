import { useCallback, useEffect, useRef, useState } from "react";
import { useClickOutside } from "../lib/hooks";

interface Props {
  options: { value: string; label?: string; hint?: string; color?: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
  allLabel: string;
  noun: string;
}

/** Dropdown of checkboxes with an "All" master toggle; closes on click outside. */
export function MultiSelect({ options, selected, onChange, allLabel, noun }: Props) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useClickOutside<HTMLDivElement>(open, close);
  const allRef = useRef<HTMLInputElement>(null);
  const all = options.length > 0 && selected.length === options.length;
  const some = selected.length > 0 && !all;

  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = some;
  }, [some, open]);

  const label = all ? allLabel : selected.length === 0 ? `No ${noun}` : `${selected.length} of ${options.length} ${noun}`;
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((s) => s !== v) : options.map((o) => o.value).filter((o) => o === v || selected.includes(o)));

  return (
    <div className="ms" ref={ref}>
      <button type="button" className="ms-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label} <span className="caret">▾</span>
      </button>
      {open && (
        <div className="ms-panel" role="listbox" aria-multiselectable>
          <label className="ms-opt ms-all">
            <input ref={allRef} type="checkbox" checked={all} onChange={() => onChange(all ? [] : options.map((o) => o.value))} />
            <span>{allLabel}</span>
          </label>
          {options.map((o) => (
            <label key={o.value} className="ms-opt">
              <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
              {o.color && <span className="swatch" style={{ background: o.color }} />}
              <span className="ms-label">{o.label ?? o.value}</span>
              {o.hint && <span className="ms-hint">{o.hint}</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
