import { describe, expect, it } from "vitest";
import { rankRows, DEFAULT_TOP_ROWS } from "./heatmapRows";

const cell = (row: string, q: number, p = q, or = 2) => ({ row, q, p, or });

describe("rankRows", () => {
  it("ranks rows by their smallest q over the groups", () => {
    const cells = [cell("a", 0.3), cell("b", 0.01), cell("a", 0.002), cell("c", 0.5), cell("b", 0.2)];
    expect(rankRows(cells, (c) => c.row).map((r) => [r.row, r.q])).toEqual([
      ["a", 0.002],
      ["b", 0.01],
      ["c", 0.5],
    ]);
  });

  it("breaks q ties by p, then keeps the order of first appearance", () => {
    const cells = [cell("a", 0.04, 0.01), cell("b", 0.04, 0.001), cell("c", 1, 1), cell("d", 1, 1)];
    expect(rankRows(cells, (c) => c.row).map((r) => r.row)).toEqual(["b", "a", "c", "d"]);
  });

  it("counts only the cells `keep` accepts; rows without one are left out", () => {
    const cells = [cell("a", 0.001, 0.001, 0.5), cell("a", 0.3, 0.3, 1.4), cell("b", 0.01, 0.01, 3), cell("c", 0.001, 0.001, 0.2)];
    expect(
      rankRows(
        cells,
        (c) => c.row,
        (c) => c.or > 1,
      ).map((r) => [r.row, r.q]),
    ).toEqual([
      ["b", 0.01],
      ["a", 0.3],
    ]);
  });

  it("ignores NaN q (an untestable cell) unless it is all a row has", () => {
    const cells = [cell("a", NaN), cell("a", 0.2), cell("b", NaN)];
    const r = rankRows(cells, (c) => c.row);
    expect(r.map((x) => x.row)).toEqual(["a", "b"]);
    expect(r[0].q).toBe(0.2);
    expect(Number.isNaN(r[1].q)).toBe(true);
  });

  it("defaults to the top 10", () => {
    expect(DEFAULT_TOP_ROWS).toBe(10);
  });
});
