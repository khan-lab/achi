import { useEffect, useState } from "react";
import { DEFAULT_TOP_ROWS } from "@achi/core/heatmapRows";

/** "Show top [10] <noun>" for an enrichment heatmap; a cleared or invalid field keeps the last valid number. */
export function TopRowsInput({ value, max, noun, onChange }: { value: number; max: number; noun: string; onChange: (n: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <label className="checkrow" title={`How many ${noun} the heatmap shows, most significant first (default ${DEFAULT_TOP_ROWS}). The table and the download keep them all.`}>
      <span className="k">Show top</span>
      <input
        className="param-text"
        type="number"
        min={1}
        max={Math.max(1, max)}
        step={1}
        value={draft}
        aria-label={`Number of ${noun} in the heatmap`}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = Math.floor(Number(e.target.value));
          if (e.target.value !== "" && Number.isFinite(n) && n >= 1) onChange(n);
        }}
        onBlur={() => setDraft(String(value))}
        style={{ width: 58 }}
      />
      <span className="k">{noun}</span>
    </label>
  );
}
