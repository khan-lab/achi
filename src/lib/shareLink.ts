/**
 * "Open in Achi" links. The part of the address after # can
 * name public files and the analysis settings:
 *
 *   #bed=<url>&name=K562&bed=<url>&name=HepG2&assembly=hg38&overlap=reciprocal50&view=upset&sel=3
 *
 * One set per bed= (regions) or list= (lists of names), in order, each
 * optionally followed by name=. A URL fragment is never sent to the app's
 * server. The files are downloaded by the browser, directly from their
 * servers, and only after the user agrees (components/LinkDialog.tsx).
 * Only https URLs are accepted (or the app's own origin, for local
 * development); nothing the user loaded from their computer is ever written
 * into a link (App.tsx writes files only when every set came from one).
 */
import type { InputMode } from "@achi/core/analysisExport";
import type { OverlapPreset } from "@achi/core/bedtoolsOptions";
import { MAX_FILE_BYTES, SUPPORTED_ASSEMBLIES } from "@achi/core/inputValidation";
import { LIST_EXTENSION } from "@achi/core/lists";
import { MAX_SETS } from "../types";
import { isSetKey } from "@achi/core/selection";

type PairwiseStat = "jaccard" | "fisher" | "reldist";

export interface LinkSettings {
  assembly: string;
  overlapPreset: OverlapPreset;
  /** The Advanced bedtools field, e.g. "f=0.25,r". */
  advanced: string;
  blacklistFilter: boolean;
  upsetSort: "size" | "degree";
  upsetMinSize: number;
  pairwiseStat: PairwiseStat;
}

/** The app's defaults (state/store.ts); a link leaves these out. */
export const LINK_DEFAULTS: LinkSettings = {
  assembly: "hg38",
  overlapPreset: "1bp",
  advanced: "",
  blacklistFilter: false,
  upsetSort: "size",
  upsetMinSize: 0,
  pairwiseStat: "jaccard",
};

export interface LinkFile {
  url: string;
  name?: string;
  host: string;
  /** What the set's file is called once downloaded (decides how it is read: .gz, .narrowPeak …). */
  fileName: string;
}

export interface ParsedLink {
  /** Set only when the link names files. */
  mode?: InputMode;
  files: LinkFile[];
  settings: Partial<LinkSettings>;
  view?: string;
  sel: number[];
  /** Parts of the link that were skipped, and why (shown before anything is downloaded). */
  problems: string[];
}

const NAME_MAX = 60;
const URL_MAX = 2000;
const PRESETS: OverlapPreset[] = ["1bp", "fraction50", "reciprocal50"];
const STATS: PairwiseStat[] = ["jaccard", "fisher", "reldist"];
/** Flags and numbers only, as the Advanced field takes them: "f=0.5,r", "F=0.1,e,s". */
const BEDTOOLS = /^[A-Za-z]{1,12}(=\d*\.?\d+)?(,[A-Za-z]{1,12}(=\d*\.?\d+)?)*$/;
const REGION_EXTENSION = /\.(bed|narrowPeak|broadPeak|bedGraph|vcf)(\.gz)?$/i;

function checkUrl(raw: string, ownOrigin?: string): { url: URL } | { problem: string } {
  const shown = raw.length > 80 ? `${raw.slice(0, 77)}…` : raw;
  if (raw.length > URL_MAX) return { problem: `Skipped a file URL longer than ${URL_MAX} characters.` };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { problem: `Skipped "${shown}": not a web address.` };
  }
  if (url.username || url.password) return { problem: `Skipped ${url.host}: the address contains a user name or password.` };
  const own = ownOrigin !== undefined && url.origin === ownOrigin;
  if (url.protocol !== "https:" && !own) return { problem: `Skipped ${shown}: only https addresses can be opened from a link.` };
  return { url };
}

function tidyName(raw: string): string | undefined {
  const name = raw.replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  return name || undefined;
}

/** Reads the part of the address after # (with or without the #). */
export function parseLink(hash: string, opts: { ownOrigin?: string } = {}): ParsedLink {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const out: ParsedLink = { files: [], settings: {}, sel: [], problems: [] };
  let last: LinkFile | null = null;
  let leftOut = 0;
  let mixed = false;

  for (const [key, value] of params) {
    switch (key) {
      case "bed":
      case "list": {
        last = null;
        const mode: InputMode = key === "bed" ? "regions" : "lists";
        if (out.mode && out.mode !== mode) {
          mixed = true;
          break;
        }
        const checked = checkUrl(value, opts.ownOrigin);
        if ("problem" in checked) {
          out.problems.push(checked.problem);
          break;
        }
        out.mode = mode;
        if (out.files.length >= MAX_SETS) {
          leftOut++;
          break;
        }
        last = { url: checked.url.href, host: checked.url.host, fileName: fileNameFromUrl(checked.url.href, mode) };
        out.files.push(last);
        break;
      }
      case "name": {
        const name = tidyName(value);
        if (last && name) last.name = name;
        last = null;
        break;
      }
      case "assembly":
        if ((SUPPORTED_ASSEMBLIES as readonly string[]).includes(value)) out.settings.assembly = value;
        else out.problems.push(`Ignored assembly "${value}": use ${SUPPORTED_ASSEMBLIES.join(", ")}.`);
        break;
      case "overlap":
        if ((PRESETS as string[]).includes(value)) out.settings.overlapPreset = value as OverlapPreset;
        else out.problems.push(`Ignored overlap "${value}": use ${PRESETS.join(", ")}.`);
        break;
      case "bedtools":
        if (BEDTOOLS.test(value)) out.settings.advanced = value;
        else out.problems.push(`Ignored bedtools "${value}": only flags and numbers, such as f=0.5,r.`);
        break;
      case "blacklist":
        if (value === "1" || value === "0") out.settings.blacklistFilter = value === "1";
        else out.problems.push(`Ignored blacklist "${value}": use 1 or 0.`);
        break;
      case "sort":
        if (value === "size" || value === "degree") out.settings.upsetSort = value;
        else out.problems.push(`Ignored sort "${value}": use size or degree.`);
        break;
      case "min":
        if (/^\d{1,9}$/.test(value)) out.settings.upsetMinSize = Number(value);
        else out.problems.push(`Ignored min "${value}": use a whole number.`);
        break;
      case "stat":
        if ((STATS as string[]).includes(value)) out.settings.pairwiseStat = value as PairwiseStat;
        else out.problems.push(`Ignored stat "${value}": use ${STATS.join(", ")}.`);
        break;
      case "view":
        out.view = value;
        break;
      case "sel":
        out.sel = value
          .split(",")
          .filter(Boolean)
          .map(Number)
          // Subset masks, or whole sets by their negative key (lib/selection.ts).
          .filter((n) => Number.isInteger(n) && (n > 0 || isSetKey(n)));
        break;
      default:
        break; // unknown parameters (tracking tags, later versions) are ignored
    }
  }
  if (mixed) out.problems.push("A link holds either bed= files (regions) or list= files (lists of names); the other kind was skipped.");
  if (leftOut) out.problems.push(`Achi compares up to ${MAX_SETS} sets; ${leftOut} left out.`);
  return out;
}

/** The part of the address after # for these files and settings (default settings are left out). */
export function buildLink(x: { mode: InputMode; files: { url: string; name?: string }[]; settings: LinkSettings; view: string; sel: number[] }): string {
  const p = new URLSearchParams();
  for (const f of x.files) {
    p.append(x.mode === "lists" ? "list" : "bed", f.url);
    if (f.name) p.append("name", f.name);
  }
  const s = x.settings;
  const d = LINK_DEFAULTS;
  if (s.assembly !== d.assembly) p.set("assembly", s.assembly);
  if (s.overlapPreset !== d.overlapPreset) p.set("overlap", s.overlapPreset);
  if (s.advanced.trim() && BEDTOOLS.test(s.advanced.trim())) p.set("bedtools", s.advanced.trim());
  if (s.blacklistFilter !== d.blacklistFilter) p.set("blacklist", s.blacklistFilter ? "1" : "0");
  if (s.upsetSort !== d.upsetSort) p.set("sort", s.upsetSort);
  if (s.upsetMinSize !== d.upsetMinSize) p.set("min", String(s.upsetMinSize));
  if (s.pairwiseStat !== d.pairwiseStat) p.set("stat", s.pairwiseStat);
  p.set("view", x.view);
  if (x.sel.length) p.set("sel", x.sel.join(","));
  return p.toString();
}

/** What a downloaded file is called: the path's last part, a file name in the query, or a generic name. */
export function fileNameFromUrl(raw: string, mode: InputMode): string {
  const known = mode === "lists" ? LIST_EXTENSION : REGION_EXTENSION;
  const url = new URL(raw);
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const segment = decode(url.pathname.split("/").filter(Boolean).pop() ?? "");
  if (known.test(segment)) return segment;
  for (const value of url.searchParams.values()) {
    const base = value.split("/").pop() ?? "";
    if (known.test(base)) return base;
  }
  const stem = segment.replace(/\.[^.]*$/, "") || (mode === "lists" ? "list" : "regions");
  return `${stem}${mode === "lists" ? ".txt" : ".bed"}`;
}

/**
 * The upload reader decides on gzip by the name (state/store.ts), so make the
 * name match the bytes: a server may decompress a .gz on the way
 * (Content-Encoding: gzip), or serve gzip under a name without .gz.
 */
export function matchGzipName(name: string, head: Uint8Array): string {
  const isGzip = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
  const saysGzip = /\.gz$/i.test(name);
  if (saysGzip && !isGzip) return name.replace(/\.gz$/i, "");
  if (!saysGzip && isGzip) return `${name}.gz`;
  return name;
}

const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

/** Why a linked file could not be downloaded, and what to do instead. */
export function fetchFailureMessage(raw: string, why: { status?: number; error?: unknown; tooLarge?: number }): string {
  let where = raw;
  let name = raw;
  try {
    const u = new URL(raw);
    where = u.host;
    name = u.pathname.split("/").filter(Boolean).pop() ?? u.host;
  } catch {
    /* shown as given */
  }
  const instead = "Download it and drop it here instead.";
  if (why.tooLarge !== undefined) return `${name} from ${where} is ${mb(why.tooLarge)}; the limit is ${mb(MAX_FILE_BYTES)}. Large files are better handled by the Intervene command-line tool.`;
  if (why.status !== undefined) return `Could not download ${name}: ${where} answered with HTTP ${why.status}. ${instead}`;
  return `Could not download ${name}: ${where} does not allow downloads from other web pages, or could not be reached. ${instead}`;
}
