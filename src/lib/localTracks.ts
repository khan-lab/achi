/**
 * Local tracks for the genome browser: files from the user's own disk,
 * shown in the genome browser (and, for interval files, as rows of the
 * genome-wide overview), not part of the intersection analysis.
 *
 * Privacy: the file never leaves the page. igv is given the File object
 * itself (a bigWig or bigBed is read in byte ranges from it; a text file is
 * checked here first and passed on uncompressed), the configuration holds
 * no URL and no index location (`indexed: false`), so igv has nothing to
 * fetch. Tested in localTracks.test.ts.
 *
 * Formats: bigWig and bigBed (any size: only the visible part is read),
 * BED, narrowPeak, broadPeak, bedGraph and VCF (plain or .gz, up to
 * MAX_FILE_BYTES, read whole), BAM with its .bai and CRAM with its .crai
 * (any size, read in ranges). A CRAM stores reads as differences from the
 * reference genome, which the app's genome (chromosome sizes only) does not
 * have: the user also loads the reference FASTA with its .fai, checked
 * against the assembly, and the CRAM track reads the stretches it needs
 * from that local file (makeSeqFetch). Nothing is fetched from a server.
 */
import type { Interval } from "../types";
import { visibilityWindowFor, type IgvTrack } from "./browserTracks";
import { checkAssembly, InputValidationError, MAX_FILE_BYTES, normalizeRegionText, type ChromSizes } from "./inputValidation";
import { parseBed, sortIntervals } from "./intervals";

export type LocalFormat = "bigwig" | "bigbed" | "bed" | "narrowpeak" | "broadpeak" | "bedgraph" | "vcf" | "bam" | "cram";
export type LocalKind = "signal" | "annotation" | "alignment";

export interface LocalFormatInfo {
  format: LocalFormat;
  kind: LocalKind;
  /** Text formats are read whole and checked; binary ones are read by igv in ranges. */
  text: boolean;
}

export interface LocalTrack {
  id: string;
  /** The file's name as the user chose it. */
  name: string;
  /** What igv reads: the original File (bigWig/bigBed/BAM/CRAM) or the checked, uncompressed text. */
  file: File;
  /** BAM and CRAM: the .bai / .crai selected with the file. */
  index?: File;
  format: LocalFormat;
  kind: LocalKind;
  warnings: string[];
  /** Interval formats only: regions for the genome-wide overview, on the assembly's chromosomes. */
  regions?: Interval[];
  /** Text formats only: number of records, for igv's visibility window. */
  nRegions?: number;
}

/** Colour of local tracks in igv and the overview: distinct from the set palette, the reference grey-blue and the shared-subset grey. */
export const LOCAL_TRACK_COLOR = "#5b3a29";

const FORMATS: { re: RegExp; format: LocalFormat; kind: LocalKind; text: boolean }[] = [
  { re: /\.(bw|bigwig)$/, format: "bigwig", kind: "signal", text: false },
  { re: /\.(bb|bigbed)$/, format: "bigbed", kind: "annotation", text: false },
  { re: /\.bed$/, format: "bed", kind: "annotation", text: true },
  { re: /\.narrowpeak$/, format: "narrowpeak", kind: "annotation", text: true },
  { re: /\.broadpeak$/, format: "broadpeak", kind: "annotation", text: true },
  { re: /\.(bedgraph|bdg)$/, format: "bedgraph", kind: "signal", text: true },
  { re: /\.vcf$/, format: "vcf", kind: "annotation", text: true },
  { re: /\.bam$/, format: "bam", kind: "alignment", text: false },
  { re: /\.cram$/, format: "cram", kind: "alignment", text: false },
];
const SUPPORTED =
  "bigWig (.bw), bigBed (.bb), BED, narrowPeak, broadPeak, bedGraph, VCF (text files may be .gz), BAM with its .bai, or CRAM with its .crai and the reference FASTA (.fa + .fai)";

export function detectLocalFormat(fileName: string): LocalFormatInfo | { error: string } {
  const lower = fileName.toLowerCase();
  const gz = lower.endsWith(".gz");
  const base = gz ? lower.slice(0, -3) : lower;
  const hit = FORMATS.find((f) => f.re.test(base));
  if (!hit) return { error: `${fileName}: not a track format the genome browser reads. Use ${SUPPORTED}.` };
  if (gz && !hit.text) return { error: `${fileName}: bigWig, bigBed, BAM and CRAM files are already compressed; load the file without .gz.` };
  return { format: hit.format, kind: hit.kind, text: hit.text };
}

/** First four bytes of a bigWig / bigBed file, in either byte order. */
const SIGNATURE: Partial<Record<LocalFormat, { magic: number; label: string }>> = {
  bigwig: { magic: 0x888ffc26, label: "bigWig" },
  bigbed: { magic: 0x8789f2eb, label: "bigBed" },
};

const firstBytes = async (file: Blob, n: number) => new Uint8Array(await file.slice(0, n).arrayBuffer());
const startsWith = (b: Uint8Array, sig: number[]) => sig.every((x, i) => b[i] === x);
const ascii = (t: string) => [...t].map((c) => c.charCodeAt(0));

/** BAM: a BGZF block (gzip with the "BC" extra field) whose content starts with "BAM\1". */
async function isBam(file: File): Promise<boolean> {
  const h = await firstBytes(file, 18);
  if (!startsWith(h, [0x1f, 0x8b, 0x08, 0x04]) || h[12] !== 0x42 || h[13] !== 0x43) return false;
  const blockSize = (h[16] | (h[17] << 8)) + 1;
  try {
    const inflated = file.slice(0, blockSize).stream().pipeThrough(new DecompressionStream("gzip"));
    const reader = inflated.getReader();
    const { value } = await reader.read();
    void reader.cancel();
    return !!value && startsWith(value, [...ascii("BAM"), 1]);
  } catch {
    return false;
  }
}

/** Checks a BAM/CRAM and its index by their first bytes. */
async function alignmentProblem(file: File, index: File, format: "bam" | "cram"): Promise<string | null> {
  if (format === "bam") {
    if (!(await isBam(file))) return `${file.name} is not a BAM file: it does not start with a BGZF block holding "BAM".`;
    if (!startsWith(await firstBytes(index, 4), [...ascii("BAI"), 1])) return `${index.name} is not a BAM index (.bai): it does not start with "BAI".`;
  } else {
    if (!startsWith(await firstBytes(file, 4), ascii("CRAM"))) return `${file.name} is not a CRAM file: it does not start with "CRAM".`;
    if (!startsWith(await firstBytes(index, 2), [0x1f, 0x8b])) return `${index.name} is not a CRAM index (.crai): it is not gzip-compressed.`;
  }
  return null;
}

async function hasSignature(file: File, magic: number): Promise<boolean> {
  const b = await firstBytes(file, 4);
  if (b.length < 4) return false;
  const le = (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  const be = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  return le === magic || be === magic;
}

async function readText(file: File): Promise<string> {
  if (!/\.gz$/i.test(file.name)) return file.text();
  return new Response(file.stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;
const plural = (n: number, w: string) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;
const isHeader = (line: string) => !line.trim() || line[0] === "#" || line.startsWith("track") || line.startsWith("browser");
const ucscName = (c: string) => (c === "MT" ? "chrM" : `chr${c}`);

/** Rewrites the chromosome (first field) of every data line. */
function renameChroms(text: string, names: Map<string, string>): string {
  return text
    .split("\n")
    .map((line) => {
      if (isHeader(line)) return line;
      const m = /^([^\t ]+)/.exec(line);
      const to = m && names.get(m[1]);
      return to ? to + line.slice(m[1].length) : line;
    })
    .join("\n");
}

/**
 * Checks a file the user picked and returns a track for the genome browser,
 * or the reason it cannot be shown. Text files are parsed with the same
 * rules as input sets (lib/inputValidation.ts); chromosome names in the
 * Ensembl style (1, 2, MT) are renamed to the assembly's (chr1, chr2, chrM).
 */
export async function prepareLocalTrack(
  file: File,
  sizes: ChromSizes | undefined,
  id: string,
  opts: { maxBytes?: number; index?: File } = {},
): Promise<LocalTrack | { error: string }> {
  const info = detectLocalFormat(file.name);
  if ("error" in info) return info;
  const { format, kind } = info;

  if (format === "bam" || format === "cram") {
    if (!opts.index) return { error: `${file.name} needs its index (.${format === "bam" ? "bai" : "crai"}), selected together with it.` };
    const problem = await alignmentProblem(file, opts.index, format);
    if (problem) return { error: problem };
    return { id, name: file.name, file, index: opts.index, format, kind, warnings: [] };
  }

  if (!info.text) {
    const sig = SIGNATURE[format]!;
    if (!(await hasSignature(file, sig.magic))) return { error: `${file.name} is not a ${sig.label} file: its first bytes are not the ${sig.label} signature.` };
    return { id, name: file.name, file, format, kind, warnings: [] };
  }

  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES;
  const tooBig = (n: number, what: string) =>
    `${file.name}${what} is ${mb(n)}; the limit is ${mb(maxBytes)} for text tracks. Convert it to bigWig or bigBed (UCSC bedGraphToBigWig, bedToBigBed), which have no size limit here.`;
  if (file.size > maxBytes) return { error: tooBig(file.size, "") };
  let text: string;
  try {
    text = await readText(file);
  } catch {
    return { error: `${file.name} could not be read${/\.gz$/i.test(file.name) ? ": is it really gzip-compressed?" : "."}` };
  }
  if (text.length > maxBytes) return { error: tooBig(text.length, " (uncompressed)") };

  const parse = (t: string) => normalizeRegionText(t, { fileName: file.name.replace(/\.gz$/i, ""), maxRegions: Number.MAX_SAFE_INTEGER });
  let n;
  try {
    n = parse(text);
  } catch (e) {
    if (e instanceof InputValidationError) return { error: `${file.name} ${e.message}` };
    throw e;
  }

  const warnings: string[] = [];
  if (n.nSkipped) warnings.push(`Skipped ${plural(n.nSkipped, "malformed line")}, e.g. line ${n.skippedExamples[0].line}: ${n.skippedExamples[0].reason}.`);

  let fit = sizes ? checkAssembly(n.extents, sizes) : null;
  if (sizes && fit?.ensemblStyle) {
    const names = new Map(fit.unknownChroms.filter((c) => !c.startsWith("chr") && sizes[ucscName(c)] !== undefined).map((c) => [c, ucscName(c)]));
    text = renameChroms(text, names);
    n = parse(text);
    fit = checkAssembly(n.extents, sizes);
    warnings.push("Chromosome names 1, 2, … were read as chr1, chr2, … to match this assembly.");
  }

  const all = format === "bedgraph" ? null : parseBed(n.bedText);
  if (sizes && fit && !fit.fits) {
    if (fit.unknownChroms.length) {
      const off = new Set(fit.unknownChroms);
      const count = parseBed(n.bedText).filter((r) => off.has(r.chrom)).length;
      const list = fit.unknownChroms.slice(0, 4).join(", ") + (fit.unknownChroms.length > 4 ? ", …" : "");
      warnings.push(`${plural(count, "region")} on chromosomes not in this assembly (${list}) are not shown.`);
    }
    if (fit.overflowChroms.length) warnings.push(`Regions run past the end of ${fit.overflowChroms.slice(0, 4).join(", ")}: is the file from another assembly?`);
  }
  const regions = all ? sortIntervals(sizes ? all.filter((r) => r.chrom in sizes) : all) : undefined;

  const igvFile = new File([text], file.name.replace(/\.gz$/i, ""), { type: "text/plain" });
  return { id, name: file.name, file: igvFile, format, kind, warnings, regions, nRegions: n.nRegions };
}

// ---------- pairing data files with their indexes ----------

export interface LocalFileGroup {
  file: File;
  index?: File;
}

const INDEX_RE = /\.(bai|crai|fai)$/i;
const FASTA_RE = /\.(fa|fasta|fna)(\.gz)?$/i;

/**
 * Sorts one selection of files into tracks (each BAM/CRAM with its index),
 * at most one reference FASTA with its .fai, and messages for what does not
 * pair up. Indexes are matched by either convention: x.bam.bai or x.bai.
 */
export function pairLocalFiles(files: File[]): { items: LocalFileGroup[]; reference?: { fasta: File; fai: File }; errors: string[] } {
  const errors: string[] = [];
  const indexes = new Map<string, File>();
  for (const f of files) if (INDEX_RE.test(f.name)) indexes.set(f.name.toLowerCase(), f);
  const used = new Set<File>();
  const findIndex = (f: File, ext: string, dataExt: RegExp): { index?: File; names: [string, string] } => {
    const names: [string, string] = [`${f.name}.${ext}`, f.name.replace(dataExt, `.${ext}`)];
    const index = names.map((n) => indexes.get(n.toLowerCase())).find((x) => x && !used.has(x));
    if (index) used.add(index);
    return { index, names };
  };

  const items: LocalFileGroup[] = [];
  const fastas: { fasta: File; fai: File }[] = [];
  for (const f of files) {
    if (INDEX_RE.test(f.name)) continue;
    if (/\.csi$/i.test(f.name)) {
      errors.push(`${f.name}: CSI indexes are not supported; use a .bai index (samtools index without -c).`);
      continue;
    }
    if (FASTA_RE.test(f.name)) {
      const { index, names } = findIndex(f, "fai", /\.(fa|fasta|fna)(\.gz)?$/i);
      if (/\.gz$/i.test(f.name)) errors.push(`${f.name}: compressed FASTA is not supported; use the uncompressed FASTA with its .fai.`);
      else if (!index) errors.push(`${f.name} needs its index (${names[0]} or ${names[1]}), selected together with it.`);
      else fastas.push({ fasta: f, fai: index });
      continue;
    }
    const lower = f.name.toLowerCase();
    if (lower.endsWith(".bam") || lower.endsWith(".cram")) {
      const bam = lower.endsWith(".bam");
      const { index, names } = findIndex(f, bam ? "bai" : "crai", bam ? /\.bam$/i : /\.cram$/i);
      if (index) items.push({ file: f, index });
      else errors.push(`${f.name} needs its index (${names[0]} or ${names[1]}), selected together with it.`);
      continue;
    }
    items.push({ file: f });
  }
  for (const idx of indexes.values()) if (!used.has(idx)) errors.push(`${idx.name}: no matching BAM, CRAM or FASTA selected with it.`);
  if (fastas.length > 1) {
    errors.push(`${fastas.map((f) => f.fasta.name).join(", ")}: one reference FASTA at a time.`);
    return { items, errors };
  }
  return { items, reference: fastas[0], errors };
}

// ---------- reference FASTA (for CRAM) ----------

interface FaiEntry {
  length: number;
  offset: number;
  lineBases: number;
  lineWidth: number;
}

export interface LocalReference {
  id: string;
  name: string;
  fasta: File;
  fai: File;
  entries: Map<string, FaiEntry>;
  warnings: string[];
}

/** The name itself, then the other naming style (chr1 <-> 1, chrM <-> MT). */
function nameCandidates(name: string): string[] {
  const out = [name, name.startsWith("chr") ? name.slice(3) : `chr${name}`];
  if (name === "chrM") out.push("MT");
  if (name === "MT" || name === "M") out.push("chrM");
  return out;
}

const fmtBp = (n: number) => n.toLocaleString("en-US");

/**
 * Checks a reference FASTA and its .fai: the FASTA starts with a header, the
 * index parses and points at this FASTA's first sequence, and every sequence
 * that is a chromosome of the assembly has the assembly's length (a FASTA
 * of another assembly would give wrong CRAM reads, so it is refused).
 */
export async function prepareLocalReference(fasta: File, fai: File, sizes: ChromSizes | undefined, id: string): Promise<LocalReference | { error: string }> {
  if (!(await fasta.slice(0, 1024).text()).trimStart().startsWith(">")) return { error: `${fasta.name} is not a FASTA file: it does not start with a ">" header line.` };
  const entries = new Map<string, FaiEntry>();
  for (const line of (await fai.text()).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const c = line.split("\t");
    const nums = c.slice(1, 5).map(Number);
    if (c.length < 5 || nums.some((n) => !Number.isInteger(n) || n < 0)) return { error: `${fai.name} is not a FASTA index (.fai): each line needs a name and four whole numbers.` };
    entries.set(c[0], { length: nums[0], offset: nums[1], lineBases: nums[2], lineWidth: nums[3] });
  }
  const first = entries.entries().next().value;
  if (!first) return { error: `${fai.name} is not a FASTA index (.fai): it is empty.` };
  const header = await fasta.slice(0, first[1].offset).text();
  if (!header.startsWith(`>${first[0]}`) || !/^>\S+/.test(header) || header.match(/^>(\S+)/)![1] !== first[0])
    return { error: `${fai.name} does not belong to ${fasta.name}: its first sequence (${first[0]}) is not where the index says.` };

  const warnings: string[] = [];
  if (sizes) {
    let matched = 0;
    for (const [name, e] of entries) {
      const chrom = nameCandidates(name).find((n) => n in sizes);
      if (!chrom) continue;
      if (sizes[chrom] !== e.length)
        return { error: `${fasta.name} does not match this assembly: ${name} is ${fmtBp(e.length)} bp in it but ${fmtBp(sizes[chrom])} bp in the assembly.` };
      matched++;
    }
    if (!matched) return { error: `${fasta.name} has no chromosome of this assembly (its first sequence is ${first[0]}).` };
    const total = Object.keys(sizes).length;
    if (matched < total) warnings.push(`Covers ${matched} of ${total} chromosomes of this assembly; CRAM reads on the others cannot be shown.`);
  }
  return { id, name: fasta.name, fasta, fai, entries, warnings };
}

/** Bases [start, end) (0-based) of a sequence, read through the .fai; null if the FASTA does not have it. */
export async function readReferenceSequence(ref: LocalReference, name: string, start: number, end: number): Promise<string | null> {
  const key = nameCandidates(name).find((n) => ref.entries.has(n));
  if (!key) return null;
  const e = ref.entries.get(key)!;
  const s = Math.max(0, start);
  const t = Math.min(e.length, end);
  if (t <= s) return "";
  const byteOf = (p: number) => e.offset + Math.floor(p / e.lineBases) * e.lineWidth + (p % e.lineBases);
  const text = await ref.fasta.slice(byteOf(s), byteOf(t - 1) + 1).text();
  return text.replace(/\s+/g, "").toUpperCase();
}

interface CramFileLike {
  getSamHeader(): Promise<{ tag: string; data: { tag: string; value: string }[] }[]>;
}

/**
 * The reference callback for a CRAM track. cram-js (inside igv) calls it as
 * a method of its CramFile with the sequence's index in the CRAM header and
 * a 1-based, inclusive range; the name comes from that header's @SQ lines,
 * the bases from the local FASTA. cram-js checks them against the CRAM's
 * MD5s, so a wrong reference shows as an error, not as wrong reads.
 */
export function makeSeqFetch(ref: LocalReference): (this: CramFileLike, seqId: number, start: number, end: number) => Promise<string> {
  const headers = new WeakMap<object, Promise<string[]>>();
  return async function (this: CramFileLike, seqId: number, start: number, end: number) {
    let names = headers.get(this);
    if (!names) {
      names = this.getSamHeader().then((lines) => lines.filter((l) => l.tag === "SQ").map((l) => l.data.find((d) => d.tag === "SN")?.value ?? ""));
      headers.set(this, names);
    }
    const name = (await names)[seqId];
    const seq = name ? await readReferenceSequence(ref, name, start - 1, end) : null;
    if (seq === null) throw new Error(`${name || `Sequence ${seqId}`} is not in ${ref.name}, the reference loaded for CRAM tracks.`);
    return seq;
  };
}

/** igv configuration: the File itself, the format stated, nothing to look up on a server. */
export function localTrackConfig(t: LocalTrack, reference?: LocalReference | null): IgvTrack {
  const base = { name: t.name, url: t.file, color: LOCAL_TRACK_COLOR, removable: false } as const;
  const window = t.nRegions !== undefined ? { visibilityWindow: visibilityWindowFor(t.nRegions) } : {};
  switch (t.format) {
    case "bam":
      return { name: t.name, url: t.file, indexURL: t.index, removable: false, type: "alignment", format: "bam" };
    case "cram":
      if (!reference) throw new Error(`${t.name}: a CRAM track needs the reference FASTA it was made with.`);
      return { name: t.name, url: t.file, indexURL: t.index, removable: false, type: "alignment", format: "cram", seqFetch: makeSeqFetch(reference), checkSequenceMD5: true };
    case "bigwig":
      return { ...base, type: "wig", format: "bigwig", autoscale: true, height: 60 };
    case "bedgraph":
      return { ...base, type: "wig", format: "bedgraph", indexed: false, autoscale: true, height: 60 };
    case "bigbed":
      return { ...base, type: "annotation", format: "bigbed", displayMode: "EXPANDED" };
    case "vcf":
      return { ...base, type: "variant", format: "vcf", indexed: false, ...window };
    default:
      return { ...base, type: "annotation", format: t.format, indexed: false, displayMode: "COLLAPSED", ...window };
  }
}
