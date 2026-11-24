/**
 * Which rows an enrichment heatmap shows (reference sets, motifs): each row
 * ranked by its best cell over the selected groups, smallest q first, then
 * smallest p, then the order rows first appear. The panels show the top N
 * (DEFAULT_TOP_ROWS unless the user picks another number); tables and
 * downloads keep every row.
 */
export const DEFAULT_TOP_ROWS = 10;

export function rankRows<C extends { q: number; p: number }, R>(cells: C[], rowOf: (c: C) => R, keep: (c: C) => boolean = () => true): { row: R; q: number; p: number }[] {
  const best = new Map<R, { row: R; q: number; p: number; at: number }>();
  const worse = (a: { q: number; p: number }, b: { q: number; p: number }) => {
    const qa = Number.isNaN(a.q) ? Infinity : a.q;
    const qb = Number.isNaN(b.q) ? Infinity : b.q;
    if (qa !== qb) return qa > qb;
    const pa = Number.isNaN(a.p) ? Infinity : a.p;
    const pb = Number.isNaN(b.p) ? Infinity : b.p;
    return pa > pb;
  };
  for (const c of cells) {
    if (!keep(c)) continue;
    const row = rowOf(c);
    const prev = best.get(row);
    if (!prev) best.set(row, { row, q: c.q, p: c.p, at: best.size });
    else if (worse(prev, c)) best.set(row, { ...prev, q: c.q, p: c.p });
  }
  return [...best.values()].sort((a, b) => (worse(a, b) ? 1 : worse(b, a) ? -1 : a.at - b.at)).map(({ row, q, p }) => ({ row, q, p }));
}
