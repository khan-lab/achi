/**
 * Achi as an MCP server: an AI assistant can run Achi analyses on region
 * files on this computer (native bedtools, @achi/core), the same analyses
 * and output files as the `achi run` command.
 *
 * What leaves the computer: everything a tool returns goes into the
 * assistant's context, and so to the model's provider. So tools return
 * summaries (set and subset sizes, group names, top results with q-values),
 * and full results are written to disk. Files with region-level rows
 * (subset BED files, signal matrices and per-region means, gene lists) are
 * returned only when the server was started with --allow-regions
 * (CLAUDE.md, "Core, CLI and MCP"). The input files themselves are never
 * returned.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EXTERNAL_ANNOTATIONS } from "@achi/core/externalAnnotations";
import { GO_NAMESPACES } from "@achi/core/great";
import { SUPPORTED_ASSEMBLIES } from "@achi/core/inputValidation";
import { DEFAULT_COLLECTION, MOTIF_COLLECTIONS } from "@achi/core/motifCollections";
import { validateProfileParams } from "@achi/core/signalMatrix";
import type { NodeRefDataOptions } from "@achi/node/refdata";
import { nodeRefData } from "@achi/node/refdata";
import { createNodeRuntime, type NodeRuntime } from "@achi/node/runtime";
import { runAnalysis, type AnalysisSummary } from "achi/analysis";

export const VERSION = "0.1.0";

export interface ServerOptions {
  /** Return region-level files (BED, signal matrices, gene lists) through read_result_file. Off by default. */
  allowRegions: boolean;
  /** Where results go when a call gives no output folder (default ~/achi-results). */
  outRoot?: string;
  refdata?: NodeRefDataOptions;
  bedtools?: string;
  /** The bundled achi-mcp.js, which runs the motif scan when started as a worker thread; without it the scan runs on one thread. */
  motifWorker?: string | URL;
  /** For progress lines (stderr); stdout is the protocol. */
  log?: (line: string) => void;
}

/** Files whose rows are regions or region-level values, returned only with --allow-regions. */
export function isRegionLevel(path: string): boolean {
  const p = path.replaceAll("\\", "/");
  return /(^|\/)subsets\//.test(p) || /(^|\/)genes\//.test(p) || /\.bed$/i.test(p) || /(^|\/)tables\/signal_(matrix_.*|region_means)\.tsv$/.test(p);
}

const PRIVACY = "Files are read and analysed on this computer; nothing is uploaded by Achi. What this tool returns goes into the conversation (and so to the model's provider), so it returns a summary; full results are written to the output folder.";

function summaryText(s: AnalysisSummary): string {
  return [
    `Achi: ${s.sets.length} set${s.sets.length === 1 ? "" : "s"} on ${s.assembly}${s.overlapFlags ? ` (bedtools ${s.overlapFlags})` : " (overlap of at least 1 bp)"}`,
    ...s.sets.map((x) => `- ${x.name}: ${x.regions.toLocaleString("en-US")} regions${x.blacklistRemoved !== undefined ? `, ${x.blacklistRemoved.toLocaleString("en-US")} removed by the ENCODE blacklist` : ""}${x.warnings.length ? ` (${x.warnings.join(" ")})` : ""}`),
    `Non-empty subsets: ${s.subsets.map((x) => `${x.label} (${x.regions.toLocaleString("en-US")})`).join("; ") || "none"}`,
    `Groups analysed: ${s.groups.join("; ")}`,
    ...Object.entries(s.overview).flatMap(([k, v]) => [`${k}:`, ...v.map((f) => `- ${f}`)]),
    ...Object.entries(s.findings).flatMap(([k, v]) => [`${k}: ${v.length ? "top results with q < 0.05" : "nothing with q < 0.05"}`, ...v.map((f) => `- ${f}`)]),
    `Full results (${s.files.length} files, including methods.md): ${s.out}`,
  ].join("\n");
}

export function createServer(o: ServerOptions): McpServer {
  const server = new McpServer(
    { name: "achi", version: VERSION },
    {
      instructions:
        "Achi compares, annotates and interprets genomic region sets (BED, narrowPeak, VCF) on this computer with native bedtools. " +
        "Start with run_analysis on the user's files; read_result_file reads its tables. " +
        (o.allowRegions
          ? "This server was started with --allow-regions: region-level files can be read, and their rows will enter the conversation."
          : "Results returned to you are summaries; region-level files (BED, signal matrices, gene lists) are not returned unless the server is started with --allow-regions."),
    }
  );
  let runtime: Promise<NodeRuntime> | null = null;
  const rt = () => (runtime ??= createNodeRuntime({ bedtools: o.bedtools, refdata: o.refdata, motifWorker: o.motifWorker }).catch((e) => ((runtime = null), Promise.reject(e))));
  const outputs = new Set<string>();
  const log = o.log ?? (() => {});
  const fail = (err: unknown) => ({ content: [{ type: "text" as const, text: `Achi: ${err instanceof Error ? err.message : String(err)}` }], isError: true });

  server.registerTool(
    "run_analysis",
    {
      title: "Run an Achi analysis",
      description:
        "Intersect 1–8 genomic region files on this computer and optionally run analyses: pairwise statistics between the sets (Jaccard, Fisher, reldist); on chosen groups, a per-chromosome summary, annotation by GENCODE category and distance to TSS, nearest genes, enrichment for bundled reference sets (ENCODE cCREs, VISTA, CpG islands, ClinVar, GWAS Catalog...), GO enrichment (GREAT-like or Cistrome-GO-like), JASPAR motif enrichment (needs the assembly's .2bit), and bigWig signal profiles. " +
        "Groups are set names (whole sets), subset labels such as 'HepG2 only' or 'K562 ∩ HepG2', or 'sets'/'subsets'. Writes the same files as the web app's Export analysis. " +
        PRIVACY,
      inputSchema: {
        files: z.array(z.string()).min(1).max(8).describe("Paths of region files (BED, narrowPeak or VCF; .gz allowed)"),
        names: z.array(z.string()).optional().describe("Set names, in file order (default: file names without extension)"),
        assembly: z.enum(SUPPORTED_ASSEMBLIES).default("hg38"),
        overlap: z.enum(["1bp", "fraction50", "reciprocal50"]).default("1bp").describe("What counts as an overlap"),
        bedtools_options: z.string().optional().describe("As Intervene's --bedtools-options, e.g. 'f=0.5,r=true' (overrides overlap)"),
        blacklist: z.boolean().default(false).describe("Remove regions overlapping the ENCODE blacklist first (hg38, hg19, mm10)"),
        select: z.array(z.string()).optional().describe("Groups for the analyses, in order (default: every set)"),
        summary: z.boolean().default(false).describe("Regions, base pairs and region lengths of each group, per chromosome (bedtools summary)"),
        annotate: z.boolean().default(false).describe("Each group's regions by GENCODE category (promoter, exon, intron, intergenic...) and distance to the nearest TSS"),
        pairwise: z.array(z.enum(["jaccard", "fisher", "reldist"])).optional().describe("Statistics between every ordered pair of input sets (needs 2 or more files)"),
        genes: z.boolean().default(false).describe("Nearest gene (by TSS) of each group's regions"),
        enrich: z.boolean().default(false).describe("Enrichment of each group for the bundled reference sets"),
        length_adjust: z.boolean().default(true).describe("enrich: CMH over region-length strata (true) or Fisher's exact test (false)"),
        go: z
          .object({
            method: z.enum(["great", "cistromego"]),
            namespace: z.enum(["BP", "MF", "CC"]).default("BP"),
            background: z.enum(["genome", "inputs"]).default("genome").describe("great only"),
          })
          .optional(),
        motifs: z
          .object({
            genome: z.string().describe("Path of the assembly's .2bit on this computer"),
            window: z.union([z.literal(50), z.literal(100), z.literal(250), z.literal(500)]).default(100).describe("Bases each side of the region's centre"),
            p: z.number().gt(0).lt(1).default(1e-4),
            collection: z.enum(MOTIF_COLLECTIONS.map((c) => c.id) as [string, ...string[]]).default(DEFAULT_COLLECTION),
          })
          .optional(),
        signal: z
          .object({
            files: z.array(z.string()).min(1).describe("Paths of bigWig files"),
            mode: z.enum(["scale", "reference"]).default("scale"),
            reference_point: z.enum(["start", "center", "end"]).default("center"),
            upstream: z.number().int().nonnegative().optional(),
            downstream: z.number().int().nonnegative().optional(),
            body: z.number().int().positive().optional(),
            bin: z.number().int().positive().optional(),
            sort: z.enum(["desc", "asc", "keep"]).default("desc"),
            clusters: z.number().int().min(1).max(10).default(1),
          })
          .optional(),
        out: z.string().optional().describe("Output folder (default: a new folder under ~/achi-results)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (a) => {
      try {
        const out = resolve(a.out ?? join(o.outRoot ?? join(homedir(), "achi-results"), `achi-${new Date().toISOString().replace(/[:.]/g, "-")}`));
        const d = a.signal?.mode === "reference" ? { upstream: 2000, downstream: 2000, body: 5000, bin: 50 } : { upstream: 5000, downstream: 5000, body: 5000, bin: 200 };
        const params = a.signal && {
          mode: a.signal.mode,
          referencePoint: a.signal.reference_point,
          upstream: a.signal.upstream ?? d.upstream,
          downstream: a.signal.downstream ?? d.downstream,
          body: a.signal.body ?? d.body,
          binSize: a.signal.bin ?? d.bin,
          missingAsZero: false,
        };
        const problem = params && validateProfileParams(params);
        if (problem) throw new Error(problem);
        const summary = await runAnalysis(
          await rt(),
          {
            files: a.files,
            names: a.names,
            assembly: a.assembly,
            out,
            overlapPreset: a.overlap,
            bedtoolsOptions: a.bedtools_options ?? "",
            blacklist: a.blacklist,
            select: a.select ?? [],
            summary: a.summary,
            annotate: a.annotate,
            pairwise: a.pairwise,
            genes: a.genes,
            enrich: a.enrich ? { adjust: a.length_adjust } : undefined,
            go: a.go && { method: a.go.method, ns: a.go.namespace, background: a.go.background },
            motifs: a.motifs && { genome: a.motifs.genome, half: a.motifs.window, p: a.motifs.p, collection: a.motifs.collection },
            signal: a.signal && params ? { files: a.signal.files, params, sort: a.signal.sort, k: a.signal.clusters } : undefined,
            version: VERSION,
          },
          log
        );
        outputs.add(out);
        return { content: [{ type: "text" as const, text: summaryText(summary) }] };
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "read_result_file",
    {
      title: "Read a result file",
      description:
        "Read a file from a results folder written by run_analysis in this session (e.g. tables/enrichment_reference_sets.tsv, methods.md), up to max_lines lines. " +
        (o.allowRegions
          ? "Region-level files (subsets/*.bed, signal matrices, gene lists) can be read: this server was started with --allow-regions, so their rows will enter the conversation."
          : "Region-level files (subsets/*.bed, signal matrices and region means, gene lists) are not returned: the server was not started with --allow-regions."),
      inputSchema: {
        path: z.string().describe("The file's path: absolute, or relative to the folder"),
        folder: z.string().optional().describe("The results folder, if path is relative (default: the last one written)"),
        max_lines: z.number().int().min(1).max(5000).default(100),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      try {
        const folder = a.folder ? resolve(a.folder) : [...outputs].at(-1);
        const full = isAbsolute(a.path) ? resolve(a.path) : folder ? resolve(folder, a.path) : resolve(a.path);
        const inside = [...outputs].find((d) => {
          const r = relative(d, full);
          return r && !r.startsWith("..") && !isAbsolute(r);
        });
        if (!inside) throw new Error(`${a.path} is not in a results folder written by run_analysis in this session.`);
        const rel = relative(inside, full);
        if (isRegionLevel(rel) && !o.allowRegions)
          throw new Error(`${rel} holds region-level rows, which are not returned to the conversation unless the server is started with --allow-regions. It is on disk at ${full}.`);
        const lines = (await readFile(full, "utf8")).split("\n");
        const shown = lines.slice(0, a.max_lines).join("\n");
        const more = lines.length > a.max_lines ? `\n… ${lines.length - a.max_lines} more lines in ${full}` : "";
        return { content: [{ type: "text" as const, text: shown + more }] };
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "list_reference_data",
    {
      title: "List Achi's reference data",
      description: "What run_analysis can test against for an assembly: the bundled reference region sets, GO namespaces and JASPAR collections. No user data involved.",
      inputSchema: { assembly: z.enum(SUPPORTED_ASSEMBLIES).default("hg38") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      const sets = EXTERNAL_ANNOTATIONS.filter((x) => x.assembly === a.assembly && x.path);
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Reference region sets for ${a.assembly} (enrich):`,
              ...sets.map((x) => `- ${x.name} (${x.category})`),
              `GO namespaces: ${GO_NAMESPACES.map((n) => `${n.id} ${n.label}`).join(", ")}`,
              `JASPAR 2026 collections (motifs): ${MOTIF_COLLECTIONS.map((c) => `${c.id} (${c.label})`).join(", ")}`,
            ].join("\n"),
          },
        ],
      };
    }
  );

  server.registerTool(
    "fetch_reference_data",
    {
      title: "Download Achi's reference data",
      description: "Download an assembly's reference data (tens of MB) from the Achi site for offline use, each file checked against the site's manifest. Sends no user data.",
      inputSchema: { assembly: z.enum(SUPPORTED_ASSEMBLIES) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (a) => {
      try {
        if (o.refdata?.localDir) return { content: [{ type: "text" as const, text: `Reference data is read from a local copy (${o.refdata.localDir}); nothing to download.` }] };
        const rd = nodeRefData(o.refdata);
        const got = await rd.fetchAssembly(a.assembly, (p, i, n) => log(`${i + 1}/${n} ${p}`));
        return { content: [{ type: "text" as const, text: `${a.assembly}: ${got.files.length} files (${(got.bytes / 1e6).toFixed(0)} MB) checked and kept in ${rd.cacheDir}.` }] };
      } catch (err) {
        return fail(err);
      }
    }
  );

  return server;
}
