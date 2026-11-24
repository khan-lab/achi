import { useStore } from "../state/store";
import { hasBlacklist } from "@achi/core/blacklist";
import { GAP_ASSEMBLIES, PERMUTATION_DEFAULTS, PERMUTATION_LIMITS } from "@achi/core/permutation";
import { NumField, SettingsShell } from "./GoEnrichmentPanel";
import type { usePermutation } from "./usePermutation";

export function PermutationControls({ p, nSets }: { p: ReturnType<typeof usePermutation>; nSets: number }) {
  const setSettings = useStore((s) => s.setPermutationSettings);
  const mainStatus = useStore((s) => s.status);
  const { settings, assembly, progress, shown, stale, error } = p;
  const d = PERMUTATION_DEFAULTS;
  const set = (patch: Partial<typeof settings>) => setSettings({ ...settings, ...patch });
  const supported = GAP_ASSEMBLIES.includes(assembly);
  const blacklistAvailable = hasBlacklist(assembly);
  const nChanged = (Object.keys(d) as (keyof typeof d)[]).filter((k) => settings[k] !== d[k]).length;
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="permctl">
      <div className="permrow">
        {progress ? (
          <>
            <span className="spinner" aria-hidden="true" />
            <span className="hint" style={{ margin: 0 }} role="status">
              {progress.label} · {pct}% of {progress.total.toLocaleString("en-US")} permutations
            </span>
            <button className="ghost" onClick={p.cancel}>
              Cancel
            </button>
          </>
        ) : (
          <button className="ghost" disabled={!supported || mainStatus === "running" || nSets < 2} onClick={() => void p.run()}>
            {shown ? "Run again" : "Run permutation test"}
          </button>
        )}
      </div>
      <div className="hint" style={{ margin: "0 0 8px" }}>
        {supported ? (
          <>
            Is the overlap more than chance? Each row set's regions are shuffled {settings.n.toLocaleString("en-US")} times ({settings.sameChromosome ? "on their own chromosome" : "anywhere in the genome"}, same lengths, never into assembly gaps
            {settings.excludeBlacklist && blacklistAvailable ? " or the ENCODE blacklist" : ""}); the column set stays put. Cell = observed regions overlapping ÷ mean over the shuffles. Seed {settings.seed}: the same seed gives the same result here and in the
            command-line tool.
          </>
        ) : (
          <>The permutation test needs assembly gaps, which Achi has for {GAP_ASSEMBLIES.join(", ")}.</>
        )}
      </div>
      <SettingsShell nChanged={nChanged} onReset={() => setSettings({ ...d })}>
        <NumField label="Permutations" value={settings.n} def={d.n} min={PERMUTATION_LIMITS.minN} max={PERMUTATION_LIMITS.maxN} help="More permutations give smaller attainable p-values: the smallest two-sided p is 2 / (permutations + 1)." onChange={(v) => set({ n: Math.round(v) })} />
        <NumField label="Seed" value={settings.seed} def={d.seed} min={0} max={0xffffffff} help="The same seed and inputs give the same permutations, in the web app and the command-line tool." onChange={(v) => set({ seed: Math.round(v) })} />
        <label className="param" title="On: each region stays on its own chromosome (keeps the chromosome make-up of the set). Off: anywhere in the genome, in proportion to each chromosome's allowed length.">
          <span className="k">
            Same chromosome{settings.sameChromosome !== d.sameChromosome && <span className="changed"> · default on</span>}
          </span>
          <input type="checkbox" checked={settings.sameChromosome} onChange={(e) => set({ sameChromosome: e.target.checked })} aria-label="Same chromosome" />
        </label>
        <label className="param" title={blacklistAvailable ? "Never place a shuffled region on the ENCODE blacklist." : `Achi has no ENCODE blacklist for ${assembly}; only assembly gaps are left out.`}>
          <span className="k">
            Exclude ENCODE blacklist{settings.excludeBlacklist !== d.excludeBlacklist && <span className="changed"> · default on</span>}
          </span>
          <input type="checkbox" checked={settings.excludeBlacklist} disabled={!blacklistAvailable} onChange={(e) => set({ excludeBlacklist: e.target.checked })} aria-label="Exclude ENCODE blacklist" />
        </label>
      </SettingsShell>
      {error && <div className="hint error">{error}</div>}
      {stale && !progress && <div className="setinfo" style={{ marginBottom: 8 }}>Sets, overlap or settings changed since this result. Press Run again to update it.</div>}
    </div>
  );
}
