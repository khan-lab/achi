import { describe, expect, it } from "vitest";
import { LINK_DEFAULTS, buildLink, fetchFailureMessage, fileNameFromUrl, matchGzipName, parseLink } from "./shareLink";

/**
 * "Open in Intervene Secure" links: the part after # names public files and
 * settings. It is never sent to a server (a URL fragment stays in the
 * browser); the files are downloaded only after the user agrees.
 */
const ENCODE = "https://www.encodeproject.org/files/ENCFF314QTE/@@download/ENCFF314QTE.bed.gz";
const PAGES = "https://khanlab.bio/intervene-secure/examples/hg38_ses/K562.bed";
const enc = encodeURIComponent;

describe("parseLink", () => {
  it("reads bed= files in order, each followed by an optional name=", () => {
    const l = parseLink(`#bed=${enc(ENCODE)}&name=Lung&bed=${enc(PAGES)}`);
    expect(l.mode).toBe("regions");
    expect(l.files).toEqual([
      { url: ENCODE, name: "Lung", host: "www.encodeproject.org", fileName: "ENCFF314QTE.bed.gz" },
      { url: PAGES, host: "khanlab.bio", fileName: "K562.bed" },
    ]);
    expect(l.problems).toEqual([]);
  });

  it("reads list= files as list mode", () => {
    const l = parseLink(`list=${enc("https://example.org/a/MCF7_genes.txt")}&name=MCF7`);
    expect(l.mode).toBe("lists");
    expect(l.files.map((f) => [f.fileName, f.name])).toEqual([["MCF7_genes.txt", "MCF7"]]);
  });

  it("leaves mode unset and files empty when the link names no files (settings or view only)", () => {
    const l = parseLink("#view=venn&sel=3,5,-4,-3,-512");
    expect(l.mode).toBeUndefined();
    expect(l.files).toEqual([]);
    expect(l.view).toBe("venn");
    // -4: the whole third set (lib/selection.ts); -3 and -512 are not set keys.
    expect(l.sel).toEqual([3, 5, -4]);
  });

  it("refuses anything but https, URLs with a user name or password, and unparsable URLs", () => {
    const l = parseLink(
      [`bed=${enc("http://example.org/a.bed")}`, `bed=${enc("javascript:alert(1)")}`, `bed=${enc("https://u:p@example.org/a.bed")}`, "bed=not%20a%20url", `bed=${enc(PAGES)}`].join("&")
    );
    expect(l.files.map((f) => f.url)).toEqual([PAGES]);
    expect(l.problems).toHaveLength(4);
    expect(l.problems[0]).toMatch(/http:\/\/example\.org\/a\.bed.*https/);
    expect(l.problems[2]).toMatch(/user name or password/);
  });

  it("accepts the app's own origin over http (local development)", () => {
    const own = "http://localhost:4317/intervene-secure/examples/hg38_ses/K562.bed";
    expect(parseLink(`bed=${enc(own)}`, { ownOrigin: "http://localhost:4317" }).files).toHaveLength(1);
    expect(parseLink(`bed=${enc(own)}`).files).toHaveLength(0);
  });

  it("does not mix regions and lists: list= after bed= is skipped with a reason", () => {
    const l = parseLink(`bed=${enc(PAGES)}&list=${enc("https://example.org/g.txt")}&name=G`);
    expect(l.mode).toBe("regions");
    expect(l.files).toHaveLength(1);
    expect(l.files[0].name).toBeUndefined(); // the name belonged to the skipped list
    expect(l.problems.join(" ")).toMatch(/either bed= files .* or list= files/);
  });

  it("keeps at most 8 files and says how many were left out", () => {
    const l = parseLink(Array.from({ length: 10 }, (_, i) => `bed=${enc(`https://example.org/s${i}.bed`)}`).join("&"));
    expect(l.files).toHaveLength(8);
    expect(l.problems.join(" ")).toMatch(/up to 8.*2 left out/);
  });

  it("tidies names: trims, collapses spaces, caps the length; a name before any file is ignored", () => {
    const long = "x".repeat(100);
    const l = parseLink(`name=Orphan&bed=${enc(PAGES)}&name=${enc("  K562   peaks ")}&bed=${enc(ENCODE)}&name=${long}`);
    expect(l.files.map((f) => f.name)).toEqual(["K562 peaks", "x".repeat(60)]);
  });

  it("reads valid settings and reports invalid ones without applying them", () => {
    const l = parseLink("assembly=mm10&overlap=reciprocal50&blacklist=1&sort=degree&min=5&stat=fisher");
    expect(l.settings).toEqual({ assembly: "mm10", overlapPreset: "reciprocal50", blacklistFilter: true, upsetSort: "degree", upsetMinSize: 5, pairwiseStat: "fisher" });
    const bad = parseLink("assembly=hg99&overlap=most&blacklist=maybe&sort=name&min=-3&stat=pearson");
    expect(bad.settings).toEqual({});
    expect(bad.problems).toHaveLength(6);
  });

  it("accepts bedtools= only as simple flags and numbers, as the Advanced field writes them", () => {
    expect(parseLink("bedtools=f%3D0.25%2Cr").settings.advanced).toBe("f=0.25,r");
    expect(parseLink("bedtools=f%3D0.25%2CF%3D0.1%2Ce%2Cs").settings.advanced).toBe("f=0.25,F=0.1,e,s");
    const bad = parseLink("bedtools=f%3D%24(rm)%2Cr");
    expect(bad.settings.advanced).toBeUndefined();
    expect(bad.problems).toHaveLength(1);
  });

  it("ignores parameters it does not know", () => {
    expect(parseLink("utm_source=x&foo=1").problems).toEqual([]);
  });
});

describe("buildLink", () => {
  const base = { mode: "regions" as const, settings: LINK_DEFAULTS, view: "upset", sel: [] as number[] };

  it("writes only view and selection when no files are given, and leaves default settings out", () => {
    expect(buildLink({ ...base, files: [] })).toBe("view=upset");
    expect(buildLink({ ...base, files: [], sel: [3, 5] })).toBe("view=upset&sel=3%2C5");
  });

  it("writes files with their names and the settings that differ from the defaults", () => {
    const hash = buildLink({
      ...base,
      files: [{ url: ENCODE, name: "Lung" }, { url: PAGES, name: "K562" }],
      settings: { ...LINK_DEFAULTS, assembly: "hg19", overlapPreset: "fraction50", blacklistFilter: true },
      sel: [1],
    });
    expect(hash).toBe(`bed=${enc(ENCODE)}&name=Lung&bed=${enc(PAGES)}&name=K562&assembly=hg19&overlap=fraction50&blacklist=1&view=upset&sel=1`);
  });

  it("round-trips through parseLink", () => {
    const settings = { ...LINK_DEFAULTS, advanced: "f=0.25,r", upsetSort: "degree" as const, upsetMinSize: 10, pairwiseStat: "reldist" as const };
    const hash = buildLink({ mode: "lists", files: [{ url: "https://example.org/a.txt", name: "A" }, { url: "https://example.org/b.txt", name: "B b" }], settings, view: "venn", sel: [2, 3] });
    const l = parseLink(hash);
    expect(l.mode).toBe("lists");
    expect(l.files.map((f) => [f.url, f.name])).toEqual([
      ["https://example.org/a.txt", "A"],
      ["https://example.org/b.txt", "B b"],
    ]);
    expect({ ...LINK_DEFAULTS, ...l.settings }).toEqual(settings);
    expect([l.view, l.sel]).toEqual(["venn", [2, 3]]);
  });
});

describe("fileNameFromUrl", () => {
  it("uses the last path segment when it has a known extension", () => {
    expect(fileNameFromUrl(ENCODE, "regions")).toBe("ENCFF314QTE.bed.gz");
    expect(fileNameFromUrl("https://x.org/p/My%20peaks.narrowPeak", "regions")).toBe("My peaks.narrowPeak");
  });
  it("finds the name in the query when the path has none (GEO-style download links)", () => {
    expect(fileNameFromUrl("https://www.ncbi.nlm.nih.gov/geo/download/?acc=GSM1&format=file&file=GSM1%5Fpeaks%2Ebed%2Egz", "regions")).toBe("GSM1_peaks.bed.gz");
  });
  it("falls back to a generic name with the mode's extension", () => {
    expect(fileNameFromUrl("https://x.org/download?id=7", "regions")).toBe("download.bed");
    expect(fileNameFromUrl("https://x.org/", "lists")).toBe("list.txt");
  });
});

describe("fetchFailureMessage", () => {
  it("explains a blocked or unreachable server, and what to do instead", () => {
    const m = fetchFailureMessage(PAGES, { error: new TypeError("Failed to fetch") });
    expect(m).toMatch(/khanlab\.bio/);
    expect(m).toMatch(/does not allow|could not be reached/);
    expect(m).toMatch(/download it and drop it/i);
  });
  it("names the HTTP status, and the size limit for a file that is too large", () => {
    expect(fetchFailureMessage(PAGES, { status: 404 })).toMatch(/404/);
    expect(fetchFailureMessage(PAGES, { tooLarge: 250 * 1024 * 1024 })).toMatch(/250 MB.*100 MB/);
  });
});

describe("matchGzipName", () => {
  const gz = new Uint8Array([0x1f, 0x8b, 8, 0]);
  const text = new TextEncoder().encode("chr1\t1\t2\n");
  it("keeps a name that matches the content", () => {
    expect(matchGzipName("a.bed.gz", gz)).toBe("a.bed.gz");
    expect(matchGzipName("a.bed", text)).toBe("a.bed");
  });
  it("drops .gz when the server already decompressed the file (Content-Encoding), and adds it when gzip came without it", () => {
    expect(matchGzipName("a.bed.gz", text)).toBe("a.bed");
    expect(matchGzipName("a.bed", gz)).toBe("a.bed.gz");
  });
});
