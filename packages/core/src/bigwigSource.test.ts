import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chromAlias, openBigWig } from "./bigwigSource";

/** A bigWig on the user's computer, read in byte ranges (never uploaded). */
const ROOT = join(__dirname, "..", "..", "..");
const file = (f: string, name: string) => new File([new Uint8Array(readFileSync(join(ROOT, "tests/fixtures", f)))], name);

describe("openBigWig", () => {
  it("reads the chromosome list and the intervals in a range of a real bigWig", async () => {
    const bw = await openBigWig(file("deeptools/k562_h3k27ac_ENCFF381NDD.chr21_windows.bw", "k562.bw"));
    expect(bw.chroms.get("chr21")).toBe(46709983);
    const iv = await bw.read("chr21", 14736031, 14737031);
    expect(iv.length).toBeGreaterThan(0);
    expect(iv.every((x) => x.end > 14736031 && x.start < 14737031 && Number.isFinite(x.score))).toBe(true);
    expect(await bw.read("chr22", 0, 1000)).toEqual([]);
  });
  it("answers chr-prefixed names from a file without the prefix, and the reverse", () => {
    const ens = new Map([
      ["21", 1],
      ["MT", 1],
    ]);
    expect(chromAlias("chr21", ens)).toBe("21");
    expect(chromAlias("chrM", ens)).toBe("MT");
    expect(chromAlias("chr21", new Map([["chr21", 1]]))).toBe("chr21");
    expect(chromAlias("21", new Map([["chr21", 1]]))).toBe("chr21");
    expect(chromAlias("chrUn_x", ens)).toBeNull();
  });
  it("refuses a file that is not a bigWig", async () => {
    await expect(openBigWig(file("deeptools/chr21_tss.bed", "x.bw"))).rejects.toThrow(/not a bigWig/);
    await expect(openBigWig(file("ucsc/bigBedExample.bb", "x.bb"))).rejects.toThrow(/bigBed/);
  });
});
