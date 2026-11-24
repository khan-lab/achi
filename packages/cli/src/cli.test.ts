import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { main, type Io } from "./cli";
import { stripAnsi } from "./terminal";

/**
 * The achi command. The parity tests run the web app's example analysis
 * with native bedtools and compare the tables with what the web app
 * downloaded in a browser for the same analysis
 * (tests/fixtures/parity/PROVENANCE.md). Reference data is read from this
 * repository's public/ (--refdata-dir), the files the web app serves.
 */
const ROOT = join(__dirname, "../../..");
const PUBLIC = join(ROOT, "public");
const PARITY = join(ROOT, "tests/fixtures/parity");
const EXAMPLES = ["MCF7", "GM12878", "K562", "HepG2"].map((n) => join(PUBLIC, "examples/hg38_ses", `${n}.bed`));
const hasBedtools = (() => {
  try {
    execFileSync("bedtools", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const describeIfBedtools = hasBedtools ? describe : describe.skip;
const TWO_BIT = process.env.ACHI_TEST_HG38_2BIT;
const itIf2bit = TWO_BIT && existsSync(TWO_BIT) ? it : it.skip;

function io(term: Partial<Io> = {}) {
  let out = "";
  let err = "";
  const x: Io = { out: (t) => void (out += t), err: (t) => void (err += t), env: {}, ...term };
  return { io: x, out: () => out, err: () => err };
}
const fixture = (f: string) => (f.endsWith(".gz") ? gunzipSync(readFileSync(join(PARITY, f))) : readFileSync(join(PARITY, f))).toString("utf8");
const outDir = () => mkdtempSync(join(tmpdir(), "achi-cli-"));

/**
 * Two TSVs hold the same results: the same rows, columns, text (so every
 * significance call) and integers, and decimals equal to 1e-9 relative.
 * Decimals may differ in their last digits: the web app ran in Chrome's
 * JavaScript engine and the CLI in Node's, whose exp/log/pow can round the
 * last bit differently, and long sums (hypergeometric tails) carry that
 * further. Measured on the GO table: 7,269 of 400,265 cells differ, all p or
 * q values, at most 8.7e-11 relative. Returns how many decimals were not
 * bit-identical, so the tests can report it.
 */
function sameResults(ours: string, web: string): { cells: number; lastDigit: number } {
  const a = ours.trimEnd().split("\n").map((l) => l.split("\t"));
  const b = web.trimEnd().split("\n").map((l) => l.split("\t"));
  expect(a.length).toBe(b.length);
  let cells = 0;
  let lastDigit = 0;
  a.forEach((row, i) => {
    expect(row.length, `row ${i}`).toBe(b[i].length);
    row.forEach((x, j) => {
      cells++;
      if (x === b[i][j]) return;
      const [u, v] = [Number(x), Number(b[i][j])];
      const decimal = x !== "" && Number.isFinite(u) && Number.isFinite(v) && !(Number.isInteger(u) && Number.isInteger(v));
      expect(decimal, `row ${i}, column ${j}: ${x} vs ${b[i][j]}`).toBe(true);
      expect(Math.abs(u - v) / Math.max(Math.abs(u), Math.abs(v)), `row ${i}, column ${j}: ${x} vs ${b[i][j]}`).toBeLessThan(1e-9);
      lastDigit++;
    });
  });
  return { cells, lastDigit };
}
const SELECT = ["--select", "K562", "--select", "HepG2 only", "--select", "K562 only"];

describe("achi: usage", () => {
  it("prints its version and help", async () => {
    const a = io();
    expect(await main(["--version"], a.io)).toBe(0);
    expect(a.out()).toMatch(/^achi \d+\.\d+\.\d+\n$/);
    const b = io();
    expect(await main(["--help"], b.io)).toBe(0);
    expect(b.out()).toMatch(/achi run \[options\] <file>/);
  });
  it("exits 2 with a reason for a usage error", async () => {
    for (const args of [["frobnicate"], ["run", "--motifs", EXAMPLES[0]], ["run", "--go", "magic", EXAMPLES[0]], ["run", "--assembly", "hg37", EXAMPLES[0]], ["run", "--no-such-option"], ["run", "--pairwise", "spearman", EXAMPLES[0]], ["run", "--seed", "3", EXAMPLES[0]], ["run", "--expression-padj", "0.1", EXAMPLES[0]], ["run", "--pairwise", "permutation", "--permutations", "5", EXAMPLES[0]], ["run", "--threads", "0", EXAMPLES[0]]]) {
      const a = io();
      expect(await main(args, a.io)).toBe(2);
      expect(a.err()).toMatch(/^achi: /);
    }
  });
  it("tells where reference data comes from", async () => {
    const a = io();
    expect(await main(["data", "info", "--cache-dir", "/tmp/achi-test-cache"], a.io)).toBe(0);
    expect(a.out()).toBe("reference data: https://khan-lab.github.io/achi/\ncache: /tmp/achi-test-cache\n");
  });
});

describeIfBedtools("achi run: same results as the web app", () => {
  it("writes the reference-set and GO tables the web app downloads (same results; decimals to 1e-9)", async () => {
    const out = outDir();
    const a = io();
    const code = await main(["run", ...EXAMPLES, ...SELECT, "--enrich", "--go", "great", "--genes", "--refdata-dir", PUBLIC, "--out", out, "--force", "-q"], a.io);
    expect(a.err()).toBe("");
    expect(code).toBe(0);
    const ref = sameResults(readFileSync(join(out, "tables/enrichment_reference_sets.tsv"), "utf8"), fixture("web_reference_sets.tsv"));
    const go = sameResults(readFileSync(join(out, "tables/achi-go-BP-greatlike-genome.tsv"), "utf8"), fixture("web_go_BP_greatlike_genome.tsv.gz"));
    console.info(`parity: reference sets ${ref.lastDigit} of ${ref.cells} cells differ in the last digit; GO ${go.lastDigit} of ${go.cells}`);

    // The rest of the export: inputs, subsets, genes, settings and methods.
    const sets = readFileSync(join(out, "tables/sets.tsv"), "utf8").trimEnd().split("\n");
    expect(sets[1].split("\t").slice(0, 5)).toEqual(["MCF7", "MCF7.bed", "yes", "639", sets[1].split("\t")[4]]);
    expect(readdirSync(join(out, "genes")).sort()).toEqual(["HepG2_only.genes.txt", "K562_(all).genes.txt".replace(/[()]/g, "_").replace("__", "_"), "K562_only.genes.txt"].sort());
    const settings = JSON.parse(readFileSync(join(out, "settings.json"), "utf8"));
    expect(settings).toMatchObject({ format: "achi-settings", assembly: "hg38", runner: { kind: "cli" }, selected: [{ label: "K562 (all)", whole: true }, { label: "HepG2 only" }, { label: "K562 only" }] });
    expect(readFileSync(join(out, "methods.md"), "utf8")).toMatch(/native BEDTools v2\.\d+\.\d+ \(Quinlan and Hall, 2010\) on the local computer/);
    expect(a.out()).toMatch(/^Achi: 4 sets on hg38\n {2}MCF7: 639 regions\n/);
  }, 120_000);

  it("reruns a web export's settings.json: same selection, same tables", async () => {
    const first = outDir();
    await main(["run", ...EXAMPLES, ...SELECT, "--refdata-dir", PUBLIC, "--out", first, "--force", "-q"], io().io);
    const again = outDir();
    const a = io();
    expect(await main(["run", ...EXAMPLES, "--settings", join(first, "settings.json"), "--enrich", "--refdata-dir", PUBLIC, "--out", again, "--force", "-q"], a.io)).toBe(0);
    sameResults(readFileSync(join(again, "tables/enrichment_reference_sets.tsv"), "utf8"), fixture("web_reference_sets.tsv"));
    expect(readFileSync(join(again, "tables/subsets.tsv"), "utf8")).toBe(readFileSync(join(first, "tables/subsets.tsv"), "utf8"));
  }, 120_000);

  itIf2bit("writes the motif table the web app downloads (same results; decimals to 1e-9)", async () => {
    const out = outDir();
    const a = io();
    const code = await main(["run", ...EXAMPLES, ...SELECT, "--motifs", "--genome", TWO_BIT!, "--motif-window", "500", "--refdata-dir", PUBLIC, "--out", out, "--force", "-q"], a.io);
    expect(a.err()).toBe("");
    expect(code).toBe(0);
    const m = sameResults(readFileSync(join(out, "tables/motif_enrichment_jaspar.tsv"), "utf8"), fixture("web_motifs_jaspar.tsv.gz"));
    console.info(`parity: motifs ${m.lastDigit} of ${m.cells} cells differ in the last digit`);
  }, 600_000);

  it("writes the summary, annotation and pairwise tables the web app computes, byte for byte", async () => {
    const out = outDir();
    const a = io();
    const code = await main(["run", ...EXAMPLES, ...SELECT, "--summary", "--annotate", "--pairwise", "all", "--refdata-dir", PUBLIC, "--out", out, "--force", "-q"], a.io);
    expect(a.err()).toBe("");
    expect(code).toBe(0);
    for (const t of ["summary", "annotation", "distance_to_tss", "pairwise_jaccard", "pairwise_fisher", "pairwise_reldist", "pairwise_reldist_bins"])
      expect(readFileSync(join(out, `tables/${t}.tsv`), "utf8"), t).toBe(fixture(`web_${t}.tsv`));
    const methods = readFileSync(join(out, "methods.md"), "utf8");
    expect(methods).toMatch(/bedtools summary against the hg38 chromosome sizes/);
    expect(methods).toMatch(/one of 11 categories of GENCODE v50 protein-coding transcripts/);
    expect(methods).toMatch(/Every ordered pair of input sets was compared by the Jaccard index/);
    expect(a.out()).toMatch(/\nsummary:\n {2}K562 \(all\): 1,003 regions, /);
    expect(a.out()).toMatch(/\nannotation:\n {2}K562 \(all\): TSS 62%/);
    expect(a.out()).toMatch(/\npairwise fisher:\n {2}MCF7 → HepG2: odds ratio 20, p 1\.5e-160\n/);
  }, 120_000);

  it("writes the permutation test the web app computes, byte for byte (same seeded shuffles)", async () => {
    const out = outDir();
    const a = io();
    expect(await main(["run", ...EXAMPLES, "--pairwise", "permutation", "--refdata-dir", PUBLIC, "--out", out, "--force", "-q"], a.io)).toBe(0);
    expect(readFileSync(join(out, "tables/pairwise_permutation.tsv"), "utf8")).toBe(fixture("web_pairwise_permutation.tsv"));
    expect(JSON.parse(readFileSync(join(out, "settings.json"), "utf8")).permutation).toEqual({ n: 1000, seed: 1, sameChromosome: true, excludeBlacklist: true });
    expect(readFileSync(join(out, "methods.md"), "utf8")).toMatch(/1,000 permutations.*seed 1/s);
    expect(a.out()).toMatch(/\npairwise permutation: ?\n {2}MCF7 → HepG2: 196 of 639 regions overlap/);
    // Another seed: other shuffles, the same observed counts.
    const other = outDir();
    expect(await main(["run", ...EXAMPLES, "--pairwise", "permutation", "--seed", "2", "--permutations", "200", "--refdata-dir", PUBLIC, "--out", other, "--force", "-q"], io().io)).toBe(0);
    const rows = (d: string) => readFileSync(join(d, "tables/pairwise_permutation.tsv"), "utf8").trim().split("\n").map((l) => l.split("\t"));
    expect(rows(other).map((r) => r[4])).toEqual(rows(out).map((r) => r[4]));
    expect(rows(other).map((r) => r[5])).not.toEqual(rows(out).map((r) => r[5]));
  });

  it("writes the expression tests the web app computes (same rows; decimals to 1e-9)", async () => {
    const out = outDir();
    const a = io();
    const table = join(PUBLIC, "examples/expression/HepG2_vs_K562.deseq2.tsv");
    expect(await main(["run", ...EXAMPLES, ...SELECT, "--expression", table, "--refdata-dir", PUBLIC, "--out", out, "--force", "-q"], a.io)).toBe(0);
    for (const [ours, web] of [["expression_beta.tsv", "web_expression_beta.tsv"], ["expression_nearest.tsv", "web_expression_nearest.tsv"], ["expression_targets.tsv", "web_expression_targets.tsv.gz"]]) {
      const r = sameResults(readFileSync(join(out, "tables", ours), "utf8"), fixture(web));
      console.info(`parity: ${ours} ${r.lastDigit} of ${r.cells} cells differ in the last digit`);
    }
    expect(JSON.parse(readFileSync(join(out, "settings.json"), "utf8")).expression).toEqual({ padj: 0.05, minAbsLog2fc: 1, distance: 100_000 });
    expect(readFileSync(join(out, "methods.md"), "utf8")).toMatch(/BETA/);
    expect(a.out()).toMatch(/\nexpression: ?[^\n]*\n {2}HepG2 only: nearest genes' median log2FC 1\.8 vs 0\.060 for other genes, q 3\.1e-126\n/);
  });

  it("skips pairwise statistics with one set, saying so", async () => {
    const out = outDir();
    const a = io();
    expect(await main(["run", EXAMPLES[0], "--pairwise", "jaccard", "--refdata-dir", PUBLIC, "--out", out, "--force"], a.io)).toBe(0);
    expect(a.err()).toMatch(/Pairwise statistics need two or more sets; skipped\./);
    expect(existsSync(join(out, "tables/pairwise_jaccard.tsv"))).toBe(false);
  }, 60_000);

  it("on a terminal: a live progress line that ticks off each stage, colour on stdout; the same text as without", async () => {
    const plain = io();
    const args = ["run", ...EXAMPLES, ...SELECT, "--summary", "--pairwise", "jaccard", "--refdata-dir", PUBLIC, "--force"];
    expect(await main([...args, "--out", outDir()], plain.io)).toBe(0);
    // Not a terminal: one plain line per step, no escape codes.
    expect(plain.err()).toMatch(/^Intersections: /m);
    expect(plain.err()).toMatch(/^Pairwise jaccard: MCF7 → GM12878\n/m);
    expect(plain.err()).not.toMatch(/\x1b/);

    const term = io({ outTty: true, errTty: true, columns: () => 100 });
    expect(await main([...args, "--out", outDir()], term.io)).toBe(0);
    const ticks = stripAnsi(term.err()).split(/\r|\n/).filter((l) => /^[✓✗] /.test(l));
    expect(ticks.map((l) => l.replace(/ {2}\S+$/, ""))).toEqual(["✓ Intersections", "✓ Summary", "✓ Pairwise jaccard"]);
    expect(term.err().endsWith("\n")).toBe(true);
    expect(term.out()).toMatch(/\x1b\[1mAchi:\x1b\[22m/);
    const lines = (t: string) => stripAnsi(t).split("\n").filter((l) => !l.startsWith("Wrote "));
    expect(lines(term.out())).toEqual(lines(plain.out()));

    const noColor = io({ outTty: true, errTty: true, env: { NO_COLOR: "1" } });
    expect(await main([...args, "--out", outDir()], noColor.io)).toBe(0);
    expect(noColor.out()).not.toMatch(/\x1b/);
    expect(noColor.err().replaceAll("\r\x1b[2K", "")).not.toMatch(/\x1b/); // only the line clearing
    const flag = io({ outTty: true, errTty: true });
    expect(await main([...args, "--no-color", "--out", outDir()], flag.io)).toBe(0);
    expect(flag.out()).not.toMatch(/\x1b/);
  }, 120_000);

  it("on a terminal: an error clears the progress line and is marked in red", async () => {
    const a = io({ errTty: true, env: { FORCE_COLOR: "1" } });
    expect(await main(["run", ...EXAMPLES, "--select", "Liver", "--refdata-dir", PUBLIC, "--out", outDir(), "--force"], a.io)).toBe(1);
    expect(a.err()).toMatch(/\x1b\[31machi:\x1b\[39m No set or subset called "Liver"/);
    expect(stripAnsi(a.err())).toMatch(/\n?✓ Intersections {2}\S+\n/);
  }, 60_000);

  it("refuses an unknown group, naming the sets and subsets it has", async () => {
    const a = io();
    expect(await main(["run", ...EXAMPLES, "--select", "Liver", "--refdata-dir", PUBLIC, "--out", outDir(), "--force", "-q"], a.io)).toBe(1);
    expect(a.err()).toMatch(/^achi: No set or subset called "Liver"\. Sets: MCF7, GM12878, K562, HepG2\. Subsets: /);
  }, 60_000);
});
