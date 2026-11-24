import { describe, expect, it } from "vitest";
import { LiveProgress, colorWanted, painter, stripAnsi } from "./terminal";

/**
 * How the achi command looks on a terminal. Presentation only: colour and a
 * live progress line on a terminal, plain lines everywhere else.
 */
describe("colorWanted", () => {
  it("follows no-color.org and FORCE_COLOR, then whether the stream is a terminal", () => {
    expect(colorWanted(true, {})).toBe(true);
    expect(colorWanted(false, {})).toBe(false);
    expect(colorWanted(undefined, {})).toBe(false);
    expect(colorWanted(true, { NO_COLOR: "1" })).toBe(false);
    expect(colorWanted(true, { NO_COLOR: "" })).toBe(true); // empty means unset
    expect(colorWanted(true, { TERM: "dumb" })).toBe(false);
    expect(colorWanted(false, { FORCE_COLOR: "1" })).toBe(true);
    expect(colorWanted(false, { FORCE_COLOR: "" })).toBe(true);
    expect(colorWanted(true, { FORCE_COLOR: "0" })).toBe(false);
    expect(colorWanted(true, { FORCE_COLOR: "1" }, false)).toBe(false); // --no-color wins
  });
});

describe("painter", () => {
  it("styles text only when colour is on", () => {
    expect(painter(false)("bold", "Achi")).toBe("Achi");
    const on = painter(true)("bold", "Achi");
    expect(on).toMatch(/^\x1b\[1mAchi\x1b\[22m$/);
    expect(stripAnsi(on)).toBe("Achi");
  });
});

function screen(o: { columns?: number; color?: boolean } = {}) {
  let out = "";
  let t = 0;
  const p = new LiveProgress({ write: (s) => void (out += s), paint: painter(o.color ?? false), columns: () => o.columns ?? 100, now: () => t, animate: false });
  /** What the terminal shows: each \r\x1b[2K clears the current line. */
  const lines = () => {
    const shown: string[] = [];
    let current = "";
    for (const part of stripAnsi(out.replaceAll("\r\x1b[2K", "\u0000")).split(/(\u0000|\n)/)) {
      if (part === "\u0000") current = "";
      else if (part === "\n") shown.push(current), (current = "");
      else current += part;
    }
    return { done: shown, live: current };
  };
  return { p, lines, raw: () => out, tick: (ms: number) => void (t += ms) };
}

describe("LiveProgress", () => {
  it("shows one live line per stage, with a bar when done/total are known, and ticks the stage off when the next starts", () => {
    const s = screen();
    s.p.update({ section: "Intersections", label: "Sorting MCF7", done: 1, total: 4 });
    expect(s.lines().live).toMatch(/^⠋ Intersections · Sorting MCF7 +█{5}░{15} 1\/4 +0\.0s$/);
    s.tick(400);
    s.p.update({ section: "Intersections", label: "Comparing MCF7 with K562", done: 2, total: 4 });
    expect(s.lines().live).toMatch(/Comparing MCF7 with K562 +█{10}░{10} 2\/4/);
    s.tick(100);
    s.p.update({ section: "Motif enrichment", label: "Loading JASPAR matrices" });
    expect(s.lines().done).toEqual(["✓ Intersections  0.5s"]);
    expect(s.lines().live).toMatch(/^⠋ Motif enrichment · Loading JASPAR matrices +0\.0s$/);
    s.tick(2000);
    s.p.update({ section: "Motif enrichment", label: "Scanning 1,019 JASPAR motifs", done: 250, total: 1000, unit: "motifs" });
    expect(s.lines().live).toMatch(/250\/1,000 motifs +2\.0s +~6\.0s left$/);
    s.p.done();
    expect(s.lines()).toEqual({ done: ["✓ Intersections  0.5s", "✓ Motif enrichment  2.0s"], live: "" });
    expect(s.raw().endsWith("\n")).toBe(true);
  });

  it("shows only the stage while it has not reported a step", () => {
    const s = screen();
    s.p.update({ section: "GO enrichment", label: "GO enrichment" });
    expect(s.lines().live).toBe("⠋ GO enrichment  0.0s");
  });

  it("prints notes above the live line and keeps the line", () => {
    const s = screen();
    s.p.update({ section: "Motif enrichment", label: "Reading sequence", done: 200, total: 400 });
    s.p.note("12 regions had no sequence in hg38.2bit and were left out.", "warn");
    s.p.note("downloaded refdata/hg38/genes_tss.bed (1.1 MB)");
    expect(s.lines().done).toEqual(["! 12 regions had no sequence in hg38.2bit and were left out.", "  downloaded refdata/hg38/genes_tss.bed (1.1 MB)"]);
    expect(s.lines().live).toMatch(/^⠋ Motif enrichment · Reading sequence/);
  });

  it("shortens the label to fit the terminal, never the counts", () => {
    const s = screen({ columns: 60 });
    s.p.update({ section: "Intersections", label: "Comparing a set with a very long name indeed with another one", done: 3, total: 12 });
    const live = s.lines().live;
    expect(live.length).toBeLessThanOrEqual(59);
    expect(live).toMatch(/…/);
    expect(live).toMatch(/3\/12 +0\.0s$/);
  });

  it("on failure clears the live line and marks the unfinished stage ✗; a stage already done stays ✓", () => {
    const s = screen();
    s.p.update({ section: "GO enrichment", label: "Testing terms", done: 5, total: 10 });
    s.p.fail();
    expect(s.lines()).toEqual({ done: ["✗ GO enrichment"], live: "" });
    const t = screen();
    t.p.update({ section: "Intersections", label: "Building subsets" });
    t.tick(300);
    t.p.stageDone("Intersections");
    t.p.stageDone("Summary"); // not the current stage: nothing
    t.p.fail();
    expect(t.lines()).toEqual({ done: ["✓ Intersections  0.3s"], live: "" });
  });

  it("colours the tick, the stage and the bar when colour is on", () => {
    const s = screen({ color: true });
    s.p.update({ section: "Summary", label: "K562 (all)", done: 1, total: 3 });
    s.p.done();
    expect(s.raw()).toMatch(/\x1b\[32m✓\x1b\[39m/);
    expect(s.raw()).toMatch(/\x1b\[1mSummary\x1b\[22m/);
  });
});
