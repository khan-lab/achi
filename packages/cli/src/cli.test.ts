import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { main, type Io } from "./cli";

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

function io() {
  let out = "";
  let err = "";
  const x: Io = { out: (t) => void (out += t), err: (t) => void (err += t), env: {} };
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
    for (const args of [["frobnicate"], ["run", "--motifs", EXAMPLES[0]], ["run", "--go", "magic", EXAMPLES[0]], ["run", "--assembly", "hg37", EXAMPLES[0]], ["run", "--no-such-option"]]) {
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

  it("refuses an unknown group, naming the sets and subsets it has", async () => {
    const a = io();
    expect(await main(["run", ...EXAMPLES, "--select", "Liver", "--refdata-dir", PUBLIC, "--out", outDir(), "--force", "-q"], a.io)).toBe(1);
    expect(a.err()).toMatch(/^achi: No set or subset called "Liver"\. Sets: MCF7, GM12878, K562, HepG2\. Subsets: /);
  }, 60_000);
});
