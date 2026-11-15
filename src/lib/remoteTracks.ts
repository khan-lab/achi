/**
 * Public tracks for the genome browser: ENCODE and SCREEN bigWig/bigBed
 * files that igv.js reads in byte ranges. Unlike everything else in the
 * app these come from other servers, which then learn which regions are
 * being viewed, so GenomeBrowser.tsx adds them only after the user agrees
 * (for the page session) and names the hosts first. Nothing of the user's
 * own data is sent: igv requests byte ranges of the public files; an ENCODE
 * search sends only the words typed.
 *
 * Sources: the curated lists in public/refdata/<asm>/remote/tracks.json
 * (build_remote_tracks.py: SCREEN merged signal, ENCODE cCRE registry,
 * ENCODE signal for the example cell lines), ENCODE search or accession
 * lookup, or a bigWig/bigBed URL pasted by the user.
 */
import type { IgvTrack } from "./browserTracks";

export type RemoteKind = "bigwig" | "bigbed";

export interface RemoteTrack {
  id: string;
  group: string;
  name: string;
  kind: RemoteKind;
  url: string;
  size?: number;
  md5?: string;
  lastModified?: string;
  /** Widest view (bp) in which igv draws it; for dense bigBeds such as JASPAR's motif matches. */
  visibilityWindow?: number;
  /** Shade features by their BED score (0-1000) and stack them: for bigBeds of scored predictions such as JASPAR. */
  scored?: boolean;
  source: string;
  description: string;
}

export interface RemoteTrackList {
  built: string;
  assembly: string;
  hosts: string[];
  tracks: RemoteTrack[];
}

export const ENCODE_PORTAL = "https://www.encodeproject.org";

/** The hosts the consent notice names; agreeing allows exactly these. */
export const CONSENT_HOSTS: { host: string; what: string }[] = [
  { host: "www.encodeproject.org", what: "ENCODE portal: searches and accession lookups (only the words or accession you type)" },
  { host: "encode-public.s3.amazonaws.com", what: "ENCODE's public file storage: the signal and peak files" },
  { host: "downloads.wenglab.org", what: "SCREEN (Weng lab): merged signal files" },
  { host: "hgdownload.soe.ucsc.edu", what: "UCSC Genome Browser downloads: conservation (phyloP) and JASPAR binding-site files" },
];

/** Hosts the user agreed to, for this page session only: in memory, never stored, gone on reload. */
export const consentedHosts = new Set<string>();

export const ENCODE_ASSEMBLY: Record<string, string> = { hg38: "GRCh38", hg19: "hg19", mm10: "mm10", mm9: "mm9" };

export function remoteTracksUrl(assembly: string, base: string): string {
  return `${base}refdata/${assembly}/remote/tracks.json`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function remoteTrackConfig(t: RemoteTrack): IgvTrack {
  if (t.kind === "bigwig")
    return { type: "wig", format: "bigwig", name: t.name, url: t.url, color: "#2b4ae0", autoscale: true, height: 60, removable: false };
  const base: IgvTrack = { type: "annotation", format: "bigbed", name: t.name, url: t.url, displayMode: "COLLAPSED", height: 40, visibilityWindow: t.visibilityWindow ?? 2_000_000, removable: false };
  return t.scored ? { ...base, displayMode: "EXPANDED", useScore: true, height: 120 } : base;
}

export type TrackInput =
  | { kind: "accession"; accession: string }
  | { kind: "url"; url: string; format: RemoteKind }
  | { kind: "search"; term: string }
  | { error: string };

/** One box takes an ENCODE file accession, a bigWig/bigBed URL, or search words. */
export function parseTrackInput(text: string): TrackInput {
  const t = text.trim();
  if (!t) return { error: "Type search words, an ENCODE file accession (ENCFF…) or a bigWig/bigBed URL." };
  if (/^ENCFF\d{3}[A-Z]{3}$/i.test(t)) return { kind: "accession", accession: t.toUpperCase() };
  if (/^[a-z]+:\/\//i.test(t)) {
    let u: URL;
    try {
      u = new URL(t);
    } catch {
      return { error: "That URL could not be read." };
    }
    if (u.protocol !== "https:") return { error: "Only https URLs can be loaded (this page is served over https)." };
    const path = u.pathname.toLowerCase();
    if (/\.(bw|bigwig)$/.test(path)) return { kind: "url", url: t, format: "bigwig" };
    if (/\.(bb|bigbed)$/.test(path)) return { kind: "url", url: t, format: "bigbed" };
    return { error: "Only bigWig (.bw, .bigWig) and bigBed (.bb, .bigBed) URLs can be added: igv reads just the part on screen. Add BED files as sets instead." };
  }
  return { kind: "search", term: t };
}

export function urlTrack(url: string, format?: RemoteKind): RemoteTrack {
  const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || url);
  const kind = format ?? (/\.(bb|bigbed)$/i.test(new URL(url).pathname) ? "bigbed" : "bigwig");
  return { id: url, group: "Added by URL", name, kind, url, source: url, description: `From ${hostOf(url)}` };
}

const SEARCH_FIELDS = [
  "accession",
  "file_format",
  "output_type",
  "assembly",
  "status",
  "file_size",
  "md5sum",
  "cloud_metadata.url",
  "biosample_ontology.term_name",
  "target.label",
  "assay_title",
  "dataset",
];

/** ENCODE search for released bigWig/bigBed files: by words (current assembly) or by accession (any assembly, checked after). */
export function encodeSearchUrl(q: { term: string } | { accession: string }, assembly: string, limit = 25): string {
  const p = new URLSearchParams({ type: "File", status: "released", format: "json", limit: String(limit) });
  p.append("file_format", "bigWig");
  p.append("file_format", "bigBed");
  if ("term" in q) {
    p.set("searchTerm", q.term);
    p.set("assembly", ENCODE_ASSEMBLY[assembly] ?? assembly);
  } else p.set("accession", q.accession);
  for (const f of SEARCH_FIELDS) p.append("field", f);
  return `${ENCODE_PORTAL}/search/?${p.toString()}`;
}

interface EncodeFile {
  accession: string;
  file_format: string;
  output_type?: string;
  assembly?: string;
  status?: string;
  file_size?: number;
  md5sum?: string;
  cloud_metadata?: { url?: string };
  biosample_ontology?: { term_name?: string } | null;
  target?: { label?: string } | null;
  assay_title?: string | null;
  dataset?: string;
}

export function parseEncodeSearch(json: unknown, assembly: string): { tracks: RemoteTrack[]; skipped: { accession: string; reason: string }[] } {
  const graph = ((json as { "@graph"?: EncodeFile[] })["@graph"] ?? []) as EncodeFile[];
  const want = ENCODE_ASSEMBLY[assembly] ?? assembly;
  const tracks: RemoteTrack[] = [];
  const skipped: { accession: string; reason: string }[] = [];
  for (const f of graph) {
    const url = f.cloud_metadata?.url;
    if (f.assembly !== want) skipped.push({ accession: f.accession, reason: `is on ${f.assembly ?? "no assembly"}, not ${assembly}` });
    else if (f.status !== "released") skipped.push({ accession: f.accession, reason: `is ${f.status}, not released` });
    else if (f.file_format !== "bigWig" && f.file_format !== "bigBed") skipped.push({ accession: f.accession, reason: `is ${f.file_format}; only bigWig and bigBed can be shown` });
    else if (!url || hostOf(url) !== "encode-public.s3.amazonaws.com") skipped.push({ accession: f.accession, reason: "has no public download address" });
    else {
      const parts = [f.biosample_ontology?.term_name, f.target?.label, f.assay_title, f.output_type].filter(Boolean);
      const exp = f.dataset?.split("/").filter(Boolean).pop();
      tracks.push({
        id: f.accession,
        group: "ENCODE search",
        name: parts.join(" "),
        kind: f.file_format === "bigWig" ? "bigwig" : "bigbed",
        url,
        size: f.file_size,
        md5: f.md5sum,
        source: `${ENCODE_PORTAL}/files/${f.accession}/`,
        description: `${f.accession}${exp ? `, experiment ${exp}` : ""}`,
      });
    }
  }
  return { tracks, skipped };
}
