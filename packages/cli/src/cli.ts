/**
 * The `achi` command. Argument parsing (node:util parseArgs, no
 * dependency) and output; the analysis itself is analysis.ts.
 */
import { parseArgs } from "node:util";
import type { OverlapPreset } from "@achi/core/bedtoolsOptions";
import type { GoBackground, GoMethod } from "@achi/core/goEnrichment";
import type { PairwiseStat } from "@achi/core/pairwiseStats";
import type { GoNamespace } from "@achi/core/great";
import { SUPPORTED_ASSEMBLIES } from "@achi/core/inputValidation";
import { DEFAULT_COLLECTION, MOTIF_COLLECTIONS } from "@achi/core/motifCollections";
import { validateProfileParams, type ProfileParams } from "@achi/core/signalMatrix";
import type { SignalSort } from "@achi/core/signalRun";
import { defaultThreads } from "@achi/node/motifThreads";
import { DEFAULT_SITE, defaultCacheDir, nodeRefData } from "@achi/node/refdata";
import { createNodeRuntime } from "@achi/node/runtime";
import { runAnalysis, type AnalysisSummary, type Reporter } from "./analysis";
import { LiveProgress, colorWanted, painter, type Paint } from "./terminal";

export const VERSION = "0.1.0";

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  env: Record<string, string | undefined>;
  /** Whether stdout / stderr is a terminal (colour, and the live progress line on stderr). Unset: plain text. */
  outTty?: boolean;
  errTty?: boolean;
  /** stderr's width in characters, for the progress line. */
  columns?: () => number;
}

export interface MainOptions {
  /** The bundled achi.js, which runs the motif scan when started as a worker thread (bin.ts); without it the scan runs on one thread. */
  motifWorker?: string | URL;
}

const USAGE = `achi ${VERSION}: compare, annotate and interpret genomic intervals on this computer.

Usage:
  achi run [options] <file>...      intersect region sets and run the chosen analyses
  achi data get <assembly>          download an assembly's reference data for offline use
  achi data info                    where reference data comes from and is kept
  achi --version | --help

Inputs: 1–8 files in BED, narrowPeak or VCF format (.gz allowed).
Output (--out, default ./achi-results): the same layout as the web app's
"Export analysis": settings.json, methods.md, tables/, subsets/, genes/.

Options for run:
  -a, --assembly <name>        ${SUPPORTED_ASSEMBLIES.join(", ")} (default hg38)
  -o, --out <dir>              output directory (default achi-results); --force to write into a non-empty one
      --names <a,b,...>        set names, in file order (default: file names without extension)
      --overlap <rule>         1bp (default), fraction50, reciprocal50
      --bedtools-options <s>   as Intervene's, e.g. "f=0.5,r=true" (overrides --overlap)
      --blacklist              remove regions overlapping the ENCODE blacklist first (hg38, hg19, mm10)
  -s, --select <group>         a group for the analyses below; repeat for more. A set name ("K562"
                               or "K562 (all)"), a subset label ("HepG2 only", "K562 ∩ HepG2"),
                               "sets" (every set, the default) or "subsets" (every subset)
      --settings <file>        use a web export's settings.json (assembly, overlap, blacklist, selection)
      --summary                regions, base pairs and region lengths of each group, per chromosome
      --annotate               each group's regions by GENCODE category, and their distance to the nearest TSS
      --pairwise <stats>       statistics between every ordered pair of input sets, comma-separated:
                               jaccard, fisher, reldist (or "all")
      --genes                  nearest gene (by TSS) of each group's regions
      --enrich                 enrichment of each group for the bundled reference sets
      --no-length-adjust       ... with Fisher's exact test instead of CMH over length strata
      --go <method>            GO enrichment: great or cistromego
      --go-namespace <ns>      BP (default), MF, CC
      --go-background <b>      great only: genome (default) or inputs
      --motifs                 JASPAR motif enrichment; needs --genome
      --genome <file.2bit>     the assembly's .2bit on this computer
      --motif-window <bp>      bases each side of the centre: 50, 100 (default), 250, 500
      --motif-p <p>            site p-value (default 1e-4)
      --motif-collection <id>  ${MOTIF_COLLECTIONS.map((c) => c.id).join(", ")} (default ${DEFAULT_COLLECTION})
      --threads <n>            threads for the motif scan (default ${defaultThreads()} on this computer)
      --signal <file.bw>       signal profiles over this bigWig; repeat for more
      --signal-mode <m>        scale (default) or reference
      --upstream, --downstream, --body, --bin <bp>   profile layout (defaults: scale 5000/5000/5000/200, reference 2000/2000/-/50)
      --reference-point <p>    start, center (default), end
      --sort <s>               desc (default), asc, keep;   --clusters <k>  k-means clusters of the rows
  -q, --quiet                  no progress messages
      --no-color               no colour (also NO_COLOR=1); colour and the live progress line
                               appear only on a terminal

Reference data and tools:
      --refdata-url <url>      the Achi site reference data is downloaded from (default ${DEFAULT_SITE})
      --refdata-dir <dir>      read reference data from a local copy of the site's files instead
      --cache-dir <dir>        where downloaded reference data is kept (default ~/.cache/achi)
      --bedtools <path>        the bedtools binary (default: bedtools on PATH; 2.31 or newer)
  Environment: ACHI_REFDATA_URL, ACHI_REFDATA_DIR, ACHI_CACHE_DIR, ACHI_BEDTOOLS.
`;

const OPTIONS = {
  assembly: { type: "string", short: "a" },
  out: { type: "string", short: "o" },
  force: { type: "boolean" },
  names: { type: "string" },
  overlap: { type: "string" },
  "bedtools-options": { type: "string" },
  blacklist: { type: "boolean" },
  select: { type: "string", short: "s", multiple: true },
  settings: { type: "string" },
  summary: { type: "boolean" },
  annotate: { type: "boolean" },
  pairwise: { type: "string" },
  threads: { type: "string" },
  genes: { type: "boolean" },
  enrich: { type: "boolean" },
  "no-length-adjust": { type: "boolean" },
  go: { type: "string" },
  "go-namespace": { type: "string" },
  "go-background": { type: "string" },
  motifs: { type: "boolean" },
  genome: { type: "string" },
  "motif-window": { type: "string" },
  "motif-p": { type: "string" },
  "motif-collection": { type: "string" },
  signal: { type: "string", multiple: true },
  "signal-mode": { type: "string" },
  upstream: { type: "string" },
  downstream: { type: "string" },
  body: { type: "string" },
  bin: { type: "string" },
  "reference-point": { type: "string" },
  sort: { type: "string" },
  clusters: { type: "string" },
  quiet: { type: "boolean", short: "q" },
  "no-color": { type: "boolean" },
  "refdata-url": { type: "string" },
  "refdata-dir": { type: "string" },
  "cache-dir": { type: "string" },
  bedtools: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

class UsageError extends Error {}

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(value)) throw new UsageError(`--${name} must be one of ${allowed.join(", ")}; got "${value}".`);
  return value as T;
}

function num(name: string, value: string | undefined, fallback: number, ok: (n: number) => boolean = (n) => Number.isFinite(n)): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!ok(n)) throw new UsageError(`--${name} must be a number; got "${value}".`);
  return n;
}

function printSummary(s: AnalysisSummary, io: Io, p: Paint) {
  const heading = (k: string) => p("bold", `${k}:`);
  const lines = [
    `${p("bold", "Achi:")} ${s.sets.length} set${s.sets.length === 1 ? "" : "s"} on ${s.assembly}${s.overlapFlags ? ` (bedtools ${s.overlapFlags})` : ""}`,
    ...s.sets.map((x) => `  ${p("cyan", x.name)}: ${x.regions.toLocaleString("en-US")} regions${x.blacklistRemoved !== undefined ? ` (${x.blacklistRemoved.toLocaleString("en-US")} removed by the ENCODE blacklist)` : ""}`),
    `${s.subsets.length} non-empty subsets; analysed: ${s.groups.map((g) => p("cyan", g)).join("; ")}`,
    ...Object.entries(s.overview).flatMap(([k, v]) => [heading(k), ...v.map((f) => `  ${f}`)]),
    ...Object.entries(s.findings).flatMap(([k, v]) => [`${heading(k)} ${v.length ? "" : p("dim", "nothing with q < 0.05")}`, ...v.map((f) => `  ${f}`)]),
    `Wrote ${s.files.length} files to ${p("green", s.out)}`,
  ];
  io.out(lines.join("\n") + "\n");
}

const PAIRWISE_STATS: PairwiseStat[] = ["jaccard", "fisher", "reldist"];

function pairwiseStats(value: string | undefined): PairwiseStat[] | undefined {
  if (value === undefined) return undefined;
  const asked = value.split(",").map((x) => x.trim()).filter(Boolean);
  if (asked.includes("all")) return PAIRWISE_STATS;
  for (const x of asked) if (!(PAIRWISE_STATS as string[]).includes(x)) throw new UsageError(`--pairwise takes ${PAIRWISE_STATS.join(", ")} or all; got "${x}".`);
  if (!asked.length) throw new UsageError(`--pairwise takes ${PAIRWISE_STATS.join(", ")} or all.`);
  return PAIRWISE_STATS.filter((x) => asked.includes(x));
}

export async function main(argv: string[], io: Io, mo: MainOptions = {}): Promise<number> {
  // Until the options are parsed (a usage error), colour follows the environment alone.
  let errPaint = painter(colorWanted(io.errTty, io.env));
  let live: LiveProgress | null = null;
  try {
    const { values: v, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    const noColor = v["no-color"] ? false : undefined;
    const outPaint = painter(colorWanted(io.outTty, io.env, noColor));
    errPaint = painter(colorWanted(io.errTty, io.env, noColor));
    if (v.version) return io.out(`achi ${VERSION}\n`), 0;
    const [command, ...rest] = positionals;
    if (v.help || !command) return io.out(USAGE.replace(/^(\S[^\n]*:)$/gm, (h) => outPaint("bold", h))), command || v.help ? 0 : 2;
    const refdataOpts = {
      baseUrl: v["refdata-url"] ?? io.env.ACHI_REFDATA_URL,
      localDir: v["refdata-dir"] ?? io.env.ACHI_REFDATA_DIR,
      cacheDir: v["cache-dir"] ?? io.env.ACHI_CACHE_DIR,
    };
    // Progress and notes on stderr: nothing with -q; a live line on a terminal (not a "dumb" one); else one plain line per step.
    if (!v.quiet && io.errTty && io.env.TERM !== "dumb") live = new LiveProgress({ write: io.err, paint: errPaint, columns: io.columns ?? (() => 80) });
    const reporter: Reporter = v.quiet
      ? { note: () => {} }
      : live
        ? { note: (line, kind) => live!.note(line, kind), progress: (p) => live!.update(p), stageDone: (section) => live!.stageDone(section) }
        : { note: (line, kind) => io.err(`${kind === "warn" ? `${errPaint("yellow", "warning:")} ` : ""}${line}\n`) };
    const log = (line: string) => reporter.note(line);

    if (command === "data") {
      const [sub, assembly] = rest;
      const rd = nodeRefData({ ...refdataOpts, onDownload: (p, b) => log(`downloaded ${p} (${(b / 1e6).toFixed(1)} MB)`) });
      if (sub === "info") {
        io.out(
          [
            `reference data: ${refdataOpts.localDir ? `local copy at ${refdataOpts.localDir}` : rd.baseUrl}`,
            `cache: ${rd.cacheDir}${rd.cacheDir === defaultCacheDir() ? " (the default)" : ""}`,
          ].join("\n") + "\n"
        );
        return 0;
      }
      if (sub === "get" && assembly) {
        if (!(SUPPORTED_ASSEMBLIES as readonly string[]).includes(assembly)) throw new UsageError(`Unknown assembly ${assembly}; choose one of ${SUPPORTED_ASSEMBLIES.join(", ")}.`);
        if (refdataOpts.localDir) throw new UsageError("--refdata-dir reads a local copy; there is nothing to download.");
        const got = await rd.fetchAssembly(assembly, (p, i, n) => (reporter.progress ? reporter.progress({ section: `Reference data for ${assembly}`, label: p, done: i, total: n, unit: "files" }) : log(`${i + 1}/${n} ${p}`)));
        reporter.stageDone?.(`Reference data for ${assembly}`);
        live?.done();
        io.out(`${assembly}: ${got.files.length} files (${(got.bytes / 1e6).toFixed(0)} MB) checked and kept in ${rd.cacheDir}\n`);
        return 0;
      }
      throw new UsageError("Usage: achi data get <assembly> | achi data info");
    }

    if (command !== "run") throw new UsageError(`Unknown command "${command}". Try achi --help.`);
    const mode = oneOf("signal-mode", v["signal-mode"], ["scale", "reference"] as const, "scale");
    const d = mode === "scale" ? { upstream: 5000, downstream: 5000, body: 5000, binSize: 200 } : { upstream: 2000, downstream: 2000, body: 5000, binSize: 50 };
    const params: ProfileParams = {
      mode,
      referencePoint: oneOf("reference-point", v["reference-point"], ["start", "center", "end"] as const, "center"),
      upstream: num("upstream", v.upstream, d.upstream),
      downstream: num("downstream", v.downstream, d.downstream),
      body: num("body", v.body, d.body),
      binSize: num("bin", v.bin, d.binSize),
      missingAsZero: false,
    };
    if (v.signal?.length) {
      const problem = validateProfileParams(params);
      if (problem) throw new UsageError(problem);
    }
    if (v.motifs && !v.genome) throw new UsageError("--motifs needs --genome <the assembly's .2bit>.");
    const go = v.go === undefined ? undefined : oneOf("go", v.go, ["great", "cistromego"] as const, "great");

    const pairwise = pairwiseStats(v.pairwise);
    const threads = v.threads === undefined ? undefined : num("threads", v.threads, 1, (n) => Number.isInteger(n) && n >= 1 && n <= 64);

    const rt = await createNodeRuntime({
      bedtools: v.bedtools ?? io.env.ACHI_BEDTOOLS,
      refdata: { ...refdataOpts, onDownload: (p, b) => log(`downloaded ${p} (${(b / 1e6).toFixed(1)} MB)`) },
      motifWorker: mo.motifWorker,
      threads,
    });
    try {
      const summary = await runAnalysis(
        rt,
        {
          files: rest,
          names: v.names?.split(",").map((n) => n.trim()),
          assembly: oneOf("assembly", v.assembly, SUPPORTED_ASSEMBLIES, "hg38"),
          out: v.out ?? "achi-results",
          force: v.force,
          overlapPreset: oneOf<OverlapPreset>("overlap", v.overlap, ["1bp", "fraction50", "reciprocal50"], "1bp"),
          bedtoolsOptions: v["bedtools-options"] ?? "",
          blacklist: v.blacklist ?? false,
          select: v.select ?? [],
          settings: v.settings,
          summary: v.summary,
          annotate: v.annotate,
          pairwise,
          genes: v.genes,
          enrich: v.enrich ? { adjust: !v["no-length-adjust"] } : undefined,
          go: go && {
            method: go as GoMethod,
            ns: oneOf<GoNamespace>("go-namespace", v["go-namespace"], ["BP", "MF", "CC"], "BP"),
            background: oneOf<GoBackground>("go-background", v["go-background"], ["genome", "inputs"], "genome"),
          },
          motifs: v.motifs
            ? {
                genome: v.genome!,
                half: num("motif-window", v["motif-window"], 100, (n) => [50, 100, 250, 500].includes(n)),
                p: num("motif-p", v["motif-p"], 1e-4, (n) => n > 0 && n < 1),
                collection: v["motif-collection"] ?? DEFAULT_COLLECTION,
              }
            : undefined,
          signal: v.signal?.length
            ? { files: v.signal, params, sort: oneOf<SignalSort>("sort", v.sort, ["desc", "asc", "keep"], "desc"), k: num("clusters", v.clusters, 1, (n) => Number.isInteger(n) && n >= 1 && n <= 10) }
            : undefined,
          version: VERSION,
        },
        reporter
      );
      live?.done();
      printSummary(summary, io, outPaint);
      return 0;
    } finally {
      await rt.close();
    }
  } catch (err) {
    live?.fail();
    const usage = err instanceof UsageError || (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
    io.err(`${errPaint("red", "achi:")} ${err instanceof Error ? err.message : String(err)}\n`);
    return usage ? 2 : 1;
  }
}
