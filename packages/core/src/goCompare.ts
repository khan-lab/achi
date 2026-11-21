/**
 * GO results of several groups side by side: one row per term, or per
 * cluster of similar terms, with each group's q, fold and significance.
 *
 * Rows are the union of each group's top N significant enriched terms
 * (fold > 1). Optionally, similar terms are grouped first, as Metascape does
 * (Zhou et al. 2019; metascape.org/blog/?p=252): Cohen's kappa between the
 * terms' annotated genes, over the union of the genes of the terms being
 * clustered; distance 1 − kappa; average-linkage hierarchical clustering;
 * clusters are the subtrees joined at kappa > minKappa (0.3). A cluster is
 * labelled by its most significant term, and its cell in a group is that
 * group's most significant member. Grouping changes only what is shown;
 * every test and q-value is the group's own.
 */
import type { GoGroupResult, GoRow } from "./goEnrichment";

export const GO_CLUSTER_DEFAULTS = {
  /** Terms join a cluster at kappa above this (Metascape: 0.3). */
  minKappa: 0.3,
  /** At most this many terms are clustered: those significant in a group, most significant first. */
  maxTerms: 500,
};

export interface GoCompareCell {
  /** The term behind this cell: the row's term, or for a cluster the group's best member. */
  id: string;
  name: string;
  q: number;
  fold: number;
  significant: boolean;
}

export interface GoCompareRow {
  /** The representative term: the member with the smallest q in any group. */
  id: string;
  name: string;
  /** Every term of the row, representative first, then by smallest q. */
  members: { id: string; name: string }[];
  /** One per group, in group order; null where no member is enriched (fold > 1) in that group. */
  cells: (GoCompareCell | null)[];
  /** Groups in which the row is significant. */
  nSignificant: number;
}

export interface GoComparison {
  rows: GoCompareRow[];
  clustered: boolean;
  /** Terms that went into the clustering (0 without it). */
  nTermsClustered: number;
  /** Clusters those terms formed. */
  nClusters: number;
  /** The settings it was made with. */
  top: number;
  minKappa?: number;
}

export interface GoCompareOptions {
  /** Each group's top N significant rows go into the union. */
  top: number;
  cluster?: { termGenes: ReadonlyMap<string, readonly number[]>; minKappa: number; maxTerms?: number };
}

/** Cohen's kappa of two terms' membership over `n` genes: agreement beyond chance, 1 for identical terms. */
export function termKappa(a: readonly number[], b: readonly number[], n: number): number {
  const inA = new Set(a);
  let both = 0;
  for (const g of b) if (inA.has(g)) both++;
  return kappaFromCounts(both, a.length - both, b.length - both, n);
}

function kappaFromCounts(both: number, onlyA: number, onlyB: number, n: number): number {
  const neither = n - both - onlyA - onlyB;
  const observed = (both + neither) / n;
  const pa = (both + onlyA) / n;
  const pb = (both + onlyB) / n;
  const chance = pa * pb + (1 - pa) * (1 - pb);
  if (chance === 1) return observed === 1 ? 1 : 0;
  return (observed - chance) / (1 - chance);
}

const popcount = (x: number) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

/**
 * Cluster labels for terms given as gene lists: kappa over the union of
 * their genes, average linkage on 1 − kappa, merged while the closest pair
 * of clusters is at kappa > minKappa (distance < 1 − minKappa). Labels are
 * numbered in order of each cluster's first term. Ties go to the earliest
 * pair, so the result does not depend on the platform.
 */
export function clusterTerms(sets: readonly (readonly number[])[], minKappa: number): number[] {
  const n = sets.length;
  const index = new Map<number, number>();
  for (const s of sets) for (const g of s) if (!index.has(g)) index.set(g, index.size);
  const universe = index.size;
  const words = Math.max(1, Math.ceil(universe / 32));
  const bits = sets.map((s) => {
    const b = new Uint32Array(words);
    for (const g of s) {
      const i = index.get(g)!;
      b[i >>> 5] |= 1 << (i & 31);
    }
    return b;
  });
  const size = sets.map((s) => new Set(s).size);
  const d = new Float64Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      let both = 0;
      const a = bits[i];
      const b = bits[j];
      for (let w = 0; w < words; w++) both += popcount(a[w] & b[w]);
      d[i * n + j] = d[j * n + i] = 1 - kappaFromCounts(both, size[i] - both, size[j] - both, universe);
    }
  // Average linkage: merge the closest pair while it is below the cut; Lance–Williams update.
  const cut = 1 - minKappa;
  const alive = new Array<boolean>(n).fill(true);
  const weight = new Array<number>(n).fill(1);
  const parent = Array.from({ length: n }, (_, i) => i);
  for (;;) {
    let best = Infinity;
    let bi = -1;
    let bj = -1;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (!alive[j]) continue;
        const v = d[i * n + j];
        if (v < best) {
          best = v;
          bi = i;
          bj = j;
        }
      }
    }
    if (bi < 0 || !(best < cut)) break;
    const wi = weight[bi];
    const wj = weight[bj];
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === bi || k === bj) continue;
      const v = (wi * d[bi * n + k] + wj * d[bj * n + k]) / (wi + wj);
      d[bi * n + k] = d[k * n + bi] = v;
    }
    weight[bi] = wi + wj;
    alive[bj] = false;
    parent[bj] = bi;
  }
  const root = (i: number): number => (parent[i] === i ? i : root(parent[i]));
  const label = new Map<number, number>();
  return sets.map((_, i) => {
    const r = root(i);
    if (!label.has(r)) label.set(r, label.size);
    return label.get(r)!;
  });
}

/** The groups' results side by side; see the module comment. */
export function compareGoGroups(groups: readonly GoGroupResult[], opts: GoCompareOptions): GoComparison {
  const byGroup = groups.map((g) => new Map(g.rows.map((r) => [r.id, r])));
  const enriched = (gi: number, id: string): GoRow | null => {
    const r = byGroup[gi].get(id);
    return r && r.fold > 1 ? r : null;
  };
  const names = new Map<string, string>();
  const bestQ = new Map<string, number>();
  const significantSomewhere: string[] = [];
  const seen = new Set<string>();
  groups.forEach((g, gi) =>
    g.rows.forEach((r) => {
      names.set(r.id, r.name);
      if (r.fold <= 1) return;
      bestQ.set(r.id, Math.min(bestQ.get(r.id) ?? Infinity, r.q));
      if (r.significant && !seen.has(r.id) && enriched(gi, r.id)) {
        seen.add(r.id);
        significantSomewhere.push(r.id);
      }
    }),
  );
  const bySignificance = (a: string, b: string) => bestQ.get(a)! - bestQ.get(b)! || (a < b ? -1 : a > b ? 1 : 0);
  significantSomewhere.sort(bySignificance);

  // Units: clusters of similar terms (members already in significance order), or single terms.
  let units: string[][];
  let nTermsClustered = 0;
  let nClusters = 0;
  if (opts.cluster) {
    const candidates = significantSomewhere.slice(0, opts.cluster.maxTerms ?? GO_CLUSTER_DEFAULTS.maxTerms);
    const genes = opts.cluster.termGenes;
    const labels = clusterTerms(
      candidates.map((id) => genes.get(id) ?? []),
      opts.cluster.minKappa,
    );
    nTermsClustered = candidates.length;
    nClusters = new Set(labels).size;
    const clusters: string[][] = Array.from({ length: nClusters }, () => []);
    candidates.forEach((id, i) => clusters[labels[i]].push(id));
    units = [...clusters, ...significantSomewhere.slice(candidates.length).map((id) => [id])];
  } else {
    units = significantSomewhere.map((id) => [id]);
  }

  const cellsOf = (members: string[]) =>
    groups.map((_, gi) => {
      let best: GoRow | null = null;
      for (const id of members) {
        const r = enriched(gi, id);
        if (r && (!best || r.q < best.q)) best = r;
      }
      return best && { id: best.id, name: best.name, q: best.q, fold: best.fold, significant: best.significant };
    });
  const unitCells = units.map(cellsOf);

  // Each group's top N units by its own q, among the ones significant in it.
  const chosen = new Set<number>();
  groups.forEach((_, gi) => {
    units
      .map((_, ui) => ui)
      .filter((ui) => unitCells[ui][gi]?.significant)
      .sort((a, b) => unitCells[a][gi]!.q - unitCells[b][gi]!.q || a - b)
      .slice(0, Math.max(0, opts.top))
      .forEach((ui) => chosen.add(ui));
  });

  const rows: GoCompareRow[] = [...chosen].map((ui) => {
    const members = units[ui];
    const cells = unitCells[ui];
    return {
      id: members[0],
      name: names.get(members[0]) ?? members[0],
      members: members.map((id) => ({ id, name: names.get(id) ?? id })),
      cells,
      nSignificant: cells.filter((c) => c?.significant).length,
    };
  });
  // Shared rows first; then by the groups they are significant in, in group order; then by q.
  const signature = (r: GoCompareRow) => r.cells.map((c) => (c?.significant ? "0" : "1")).join("");
  const minQ = (r: GoCompareRow) => Math.min(...r.cells.map((c) => (c ? c.q : Infinity)));
  rows.sort((a, b) => b.nSignificant - a.nSignificant || (signature(a) < signature(b) ? -1 : signature(a) > signature(b) ? 1 : 0) || minQ(a) - minQ(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { rows, clustered: !!opts.cluster, nTermsClustered, nClusters, top: opts.top, ...(opts.cluster ? { minKappa: opts.cluster.minKappa } : {}) };
}

/** The comparison as TSV: one line per row, its other members, and each group's q, fold and significance (empty where not enriched). */
export function goCompareTsv(c: GoComparison, groups: readonly { label: string }[]): string {
  const col = (l: string) => l.replace(/\s+/g, "_");
  const head = ["go_id", "term", "n_similar", "similar_terms", ...groups.flatMap((g) => [`${col(g.label)}_q`, `${col(g.label)}_fold`, `${col(g.label)}_significant`])];
  const lines = c.rows.map((r) =>
    [
      r.id,
      r.name,
      r.members.length - 1,
      r.members
        .slice(1)
        .map((m) => `${m.id} ${m.name}`)
        .join("; "),
      ...r.cells.flatMap((x) => (x ? [x.q, x.fold, x.significant ? "yes" : "no"] : ["", "", ""])),
    ].join("\t"),
  );
  return [head.join("\t"), ...lines].join("\n") + "\n";
}
