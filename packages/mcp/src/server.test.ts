import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer, isRegionLevel } from "./server";

/**
 * The MCP server, through a real MCP client: the web app's example analysis
 * with native bedtools and this repository's public/ as reference data.
 * Checks what reaches the conversation: summaries, and region-level files
 * only with --allow-regions.
 */
const ROOT = join(__dirname, "../../..");
const PUBLIC = join(ROOT, "public");
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

async function connect(allowRegions: boolean) {
  const server = createServer({ allowRegions, refdata: { localDir: PUBLIC }, outRoot: mkdtempSync(join(tmpdir(), "achi-mcp-")) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");

describe("isRegionLevel", () => {
  it("marks subset BEDs, gene lists, signal matrices and region means; not statistics tables or methods", () => {
    for (const p of ["subsets/MCF.bed", "genes/K562_only.genes.txt", "tables/signal_matrix_K562.tsv", "tables/signal_region_means.tsv", "x/clusters.bed"]) expect(isRegionLevel(p)).toBe(true);
    for (const p of ["tables/enrichment_reference_sets.tsv", "tables/achi-go-BP-greatlike-genome.tsv", "tables/signal_tests.tsv", "tables/subsets.tsv", "tables/summary.tsv", "tables/annotation.tsv", "tables/distance_to_tss.tsv", "tables/pairwise_fisher.tsv", "tables/pairwise_reldist_bins.tsv", "methods.md", "settings.json"]) expect(isRegionLevel(p)).toBe(false);
  });
});

describe("the tools", () => {
  it("lists four tools, each saying what reaches the conversation where it matters", async () => {
    const client = await connect(false);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["fetch_reference_data", "list_reference_data", "read_result_file", "run_analysis"]);
    expect(tools.find((t) => t.name === "run_analysis")!.description).toMatch(/so it returns a summary/);
    expect(tools.find((t) => t.name === "read_result_file")!.description).toMatch(/not started with --allow-regions/);
    expect(client.getInstructions()).toMatch(/Results returned to you are summaries/);
  });
  it("lists the reference data of an assembly", async () => {
    const r = await (await connect(false)).callTool({ name: "list_reference_data", arguments: { assembly: "hg38" } });
    expect(text(r)).toMatch(/VISTA enhancers/);
    expect(text(r)).toMatch(/core-vert-nr/);
  });
});

describeIfBedtools("run_analysis and read_result_file", () => {
  it("returns a summary, writes the full results, and keeps region-level files out of the conversation", async () => {
    const client = await connect(false);
    const r = await client.callTool({ name: "run_analysis", arguments: { files: EXAMPLES, select: ["K562", "HepG2 only", "K562 only"], enrich: true, genes: true } });
    expect(r.isError).toBeFalsy();
    const t = text(r);
    expect(t).toMatch(/^Achi: 4 sets on hg38 \(overlap of at least 1 bp\)\n- MCF7: 639 regions\n/);
    expect(t).toMatch(/Groups analysed: K562 \(all\); HepG2 only; K562 only/);
    expect(t).toMatch(/enrichment: top results with q < 0\.05\n- HepG2 only: FANTOM5 enhancers \(odds ratio 0\.38, q 1\.7e-23\)\n- K562 \(all\): CpG islands/);
    expect(t).not.toMatch(/chr\d+\t\d+/); // no regions in the summary

    const table = await client.callTool({ name: "read_result_file", arguments: { path: "tables/enrichment_reference_sets.tsv", max_lines: 3 } });
    expect(text(table)).toMatch(/^subset\tsubset_code\treference_set/);
    expect(text(table)).toMatch(/… \d+ more lines in /);
    const bed = await client.callTool({ name: "read_result_file", arguments: { path: "subsets/HEP.bed" } });
    expect(bed.isError).toBe(true);
    expect(text(bed)).toMatch(/region-level rows, which are not returned to the conversation unless the server is started with --allow-regions/);
    const genes = await client.callTool({ name: "read_result_file", arguments: { path: "genes/HepG2_only.genes.txt" } });
    expect(genes.isError).toBe(true);
    const outside = await client.callTool({ name: "read_result_file", arguments: { path: "/etc/hosts" } });
    expect(text(outside)).toMatch(/is not in a results folder written by run_analysis in this session/);
  }, 120_000);

  it("returns region-level files when started with --allow-regions", async () => {
    const client = await connect(true);
    await client.callTool({ name: "run_analysis", arguments: { files: EXAMPLES.slice(0, 2) } });
    const bed = await client.callTool({ name: "read_result_file", arguments: { path: "subsets/MCF.bed", max_lines: 2 } });
    expect(bed.isError).toBeFalsy();
    expect(text(bed)).toMatch(/^chr\w+\t\d+\t\d+/);
  }, 120_000);

  it("runs the summary, annotation and pairwise statistics, returning a few lines of each", async () => {
    const client = await connect(false);
    const r = await client.callTool({ name: "run_analysis", arguments: { files: EXAMPLES, select: ["HepG2 only"], summary: true, annotate: true, pairwise: ["jaccard", "fisher"] } });
    const t = text(r);
    expect(t).toMatch(/\nsummary:\n- HepG2 only: 929 regions, /);
    expect(t).toMatch(/\nannotation:\n- HepG2 only: /);
    expect(t).toMatch(/\npairwise jaccard:\n- /);
    expect(t).toMatch(/\npairwise fisher:\n- MCF7 → HepG2: odds ratio 20, p 1\.5e-160/);
    expect(t).not.toMatch(/pairwise reldist/);
    const table = await client.callTool({ name: "read_result_file", arguments: { path: "tables/pairwise_fisher.tsv", max_lines: 2 } });
    expect(text(table)).toBe("set_a\tset_b\todds_ratio\tp_two_tail\nMCF7\tGM12878\t9.597\t1.0437e-56\n… 12 more lines in " + text(table).split("more lines in ")[1]);
  }, 120_000);

  it("reports a problem as a tool error the assistant can read", async () => {
    const r = await (await connect(false)).callTool({ name: "run_analysis", arguments: { files: [join(PUBLIC, "nope.bed")] } });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("Achi: nope.bed could not be read.");
  }, 60_000);
});
