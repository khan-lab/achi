import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanMotifsInline } from "./motifScan";
import { encodeSequence, hasHit, integerMatrix, logOddsMatrix, packSequences, thresholdForP, type Background } from "./pwm";

/**
 * The motif scanner every environment can fall back on (one thread). Real
 * data: hg38 sequence around example super-enhancers and the JASPAR 2026
 * matrices of tests/fixtures/motifs. Each motif's hits must be exactly what
 * scanning each sequence on its own gives (pwm.ts hasHit, itself checked
 * against MOODS in pwm.test.ts), with the threshold for p.
 */
const DIR = join(__dirname, "..", "..", "..", "tests", "fixtures", "motifs");
const expected: { background: Background; p: number; motifs: { pfm: number[][] }[] } = JSON.parse(readFileSync(join(DIR, "expected_moods.json"), "utf8"));
const codes = readFileSync(join(DIR, "sequences.fa"), "utf8")
  .split(">")
  .filter(Boolean)
  .map((b) => encodeSequence(b.split("\n").slice(1).join("").trim()));

describe("scanMotifsInline", () => {
  it("gives, per motif, the threshold for p and 1 for each sequence with a site, as scanning one sequence at a time", async () => {
    const pfms = expected.motifs.map((m) => m.pfm);
    const bg = expected.background;
    const progress: number[] = [];
    const r = await scanMotifsInline(packSequences(codes), pfms, bg, expected.p, { onProgress: (done, total) => progress.push(done / total) });
    expect(r.hits).toHaveLength(pfms.length);
    let withSites = 0;
    pfms.forEach((pfm, k) => {
      const m = integerMatrix(logOddsMatrix(pfm, bg));
      const t = thresholdForP(m, bg, expected.p);
      expect(r.thresholds[k]).toBe(t);
      expect(Array.from(r.hits[k])).toEqual(codes.map((c) => (hasHit(c, m, t) ? 1 : 0)));
      withSites += r.hits[k].reduce((a, b) => a + b, 0);
    });
    expect(withSites).toBeGreaterThan(100); // the fixture has real sites, so this is not all zeros
    expect(progress.at(-1)).toBe(1);
  });

  it("stops with an AbortError when the run is cancelled", async () => {
    const signal = AbortSignal.abort();
    await expect(scanMotifsInline(packSequences(codes), [expected.motifs[0].pfm], expected.background, expected.p, { signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
