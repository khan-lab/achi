import { useState } from "react";
import type { Subset } from "../types";
import { subsetFileText, useStore } from "../state/store";
import { Icon } from "./Icon";
import { SubsetItemsList, SubsetRegionsTable } from "./SubsetRegionsTable";

const fmt = (n: number) => n.toLocaleString("en-US");
const bpfmt = (bp: number) => (bp >= 1e6 ? `${(bp / 1e6).toFixed(1)} Mb` : bp >= 1e3 ? `${(bp / 1e3).toFixed(0)} kb` : `${bp} bp`);

type Tab = "regions" | "genes";
// Each card's tab, kept while the page is open (cards unmount when deselected or the column is folded).
const lastTab = new Map<number, Tab>();

/**
 * One selected subset or whole set in the "Selected subsets and sets"
 * column: its regions (default) or its nearest genes, one click apart.
 * Copy and download act on the list shown. List mode has names only.
 */
export function SelectedGroupCard({ group, genes, genesError }: { group: Subset; genes?: string[]; genesError?: string | null }) {
  const toggleSelected = useStore((s) => s.toggleSelected);
  const exportSubsetBed = useStore((s) => s.exportSubsetBed);
  const [tab, setTabState] = useState<Tab>(() => lastTab.get(group.mask) ?? "regions");
  const setTab = (t: Tab) => (lastTab.set(group.mask, t), setTabState(t));
  const [copied, setCopied] = useState(false);
  const listMode = !!group.items;
  const showGenes = !listMode && tab === "genes";

  const copy = async () => {
    const text = showGenes ? (genes ?? []).join("\n") : subsetFileText(group);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn("Could not copy to clipboard", err);
    }
  };
  const download = () => {
    if (!showGenes) return exportSubsetBed(group.mask);
    const list = genes ?? [];
    const url = URL.createObjectURL(new Blob([list.join("\n") + (list.length ? "\n" : "")], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${group.label}.genes.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };
  const what = showGenes ? "gene list" : listMode ? "names" : "BED";
  const file = showGenes ? `${group.label}.genes.txt` : `${group.code || group.mask}.${listMode ? "txt" : "bed"}`;

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="bd">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div className="nm" style={{ fontSize: 13.5, fontWeight: 500 }}>
            {group.label}
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <button className="iconbtn" title={copied ? "Copied!" : `Copy ${what} to clipboard`} aria-label={`Copy ${group.label} ${what}`} disabled={showGenes && !genes} onClick={() => void copy()}>
              <Icon name={copied ? "check" : "copy"} />
            </button>
            <button className="iconbtn" title={`Download ${file}`} aria-label={`Download ${group.label} ${what}`} disabled={showGenes && !genes} onClick={download}>
              <Icon name="download" />
            </button>
            <button className="iconbtn" title={`Close ${group.label}`} aria-label={`Deselect ${group.label}`} onClick={() => toggleSelected(group.mask)}>
              <Icon name="close" />
            </button>
          </div>
        </div>
        {listMode ? (
          <>
            <div className="mono" style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>
              {fmt(group.nRegions)} names
            </div>
            <SubsetItemsList items={group.items!} />
          </>
        ) : (
          <>
            <div className="tabs groupcard-tabs" role="tablist" aria-label={`${group.label}: regions or genes`}>
              <button className="tab" role="tab" aria-selected={tab === "regions"} onClick={() => setTab("regions")} title={`${fmt(group.nRegions)} regions · ${bpfmt(group.nBp)}`}>
                Regions <span className="tabcount">{fmt(group.nRegions)}</span>
              </button>
              <button className="tab" role="tab" aria-selected={tab === "genes"} onClick={() => setTab("genes")} title="Nearest protein-coding gene of each region">
                Genes <span className="tabcount">{genesError ? "!" : genes ? fmt(genes.length) : "…"}</span>
              </button>
            </div>
            {showGenes ? (
              <GroupGenes genes={genes} error={genesError ?? null} />
            ) : (
              <>
                <div className="mono" style={{ fontSize: 12, color: "var(--ink-3)", margin: "6px 0" }}>
                  {bpfmt(group.nBp)} in all
                </div>
                <SubsetRegionsTable subset={group} />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** One group's nearest genes: each opens in the genome browser. */
function GroupGenes({ genes, error }: { genes: string[] | undefined; error: string | null }) {
  const showInBrowser = useStore((s) => s.showInBrowser);
  return (
    <>
      <div className="hint" style={{ margin: "6px 0" }}>
        Nearest protein-coding TSS of each region, no distance cutoff. Click a gene to show it in the genome browser.
      </div>
      {error ? (
        <div className="hint error">{error}</div>
      ) : !genes ? (
        <div className="mono hint">finding nearest genes…</div>
      ) : (
        <div className="regions-scroll">
          <ul className="items-list mono">
            {genes.map((g) => (
              <li key={g}>
                <button className="linkbtn genelink" title={`Show ${g} in the genome browser`} onClick={() => showInBrowser(g)}>
                  {g}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
