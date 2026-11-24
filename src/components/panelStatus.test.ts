import { describe, expect, it } from "vitest";
import { count, panelStatus, readPanelOpen, writeAllPanelsOpen, writePanelOpen } from "./panelStatus";

/** What a collapsed analysis panel shows in its header. */
describe("panelStatus", () => {
  it("shows a running panel's progress first, whatever else it holds", () => {
    expect(panelStatus({ progress: { done: 2, total: 5, label: "x" }, error: "old", hasResult: true, done: "3 motifs" })).toEqual({ tone: "busy", text: "running 40%" });
    expect(panelStatus({ busy: true, hasResult: false })).toEqual({ tone: "busy", text: "running" });
    expect(panelStatus({ progress: { done: 0, total: 0, label: "x" }, hasResult: false })).toEqual({ tone: "busy", text: "running" });
  });

  it("then an error, then 'not run'", () => {
    expect(panelStatus({ error: "Network error", hasResult: true, done: "3 motifs" })).toEqual({ tone: "error", text: "error" });
    expect(panelStatus({ hasResult: false })).toEqual({ tone: "idle", text: "not run" });
  });

  it("shows the result, marked out of date when the settings or selection changed", () => {
    expect(panelStatus({ hasResult: true, done: "3 motifs q < 0.05" })).toEqual({ tone: "done", text: "3 motifs q < 0.05" });
    expect(panelStatus({ hasResult: true, stale: true, done: "3 motifs q < 0.05" })).toEqual({ tone: "stale", text: "out of date · 3 motifs q < 0.05" });
    expect(panelStatus({ hasResult: true })).toEqual({ tone: "done", text: "done" });
  });
});

describe("count", () => {
  it("pluralises and groups thousands", () => {
    expect(count(1, "motif")).toBe("1 motif");
    expect(count(0, "motif")).toBe("0 motifs");
    expect(count(1250, "region")).toBe("1,250 regions");
    expect(count(2, "family", "families")).toBe("2 families");
  });
});

describe("remembered open state", () => {
  function memory() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  }

  it("is open unless this browser stored it closed, per panel", () => {
    const s = memory();
    expect(readPanelOpen("motifs", s)).toBe(true);
    writePanelOpen("motifs", false, s);
    expect(readPanelOpen("motifs", s)).toBe(false);
    expect(readPanelOpen("go", s)).toBe(true);
    writePanelOpen("motifs", true, s);
    expect(readPanelOpen("motifs", s)).toBe(true);
    expect([...s.m.keys()]).toEqual(["achi.panels"]);
  });

  it("opens or closes several panels at once, leaving the others", () => {
    const s = memory();
    writePanelOpen("signal", false, s);
    writeAllPanelsOpen(["motifs", "go"], false, s);
    expect(["motifs", "go", "signal", "summary"].map((id) => readPanelOpen(id, s))).toEqual([false, false, false, true]);
    writeAllPanelsOpen(["motifs", "go"], true, s);
    expect(["motifs", "go", "signal"].map((id) => readPanelOpen(id, s))).toEqual([true, true, false]);
  });

  it("ignores storage that is missing, throws or holds junk", () => {
    expect(readPanelOpen("motifs", null)).toBe(true);
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readPanelOpen("motifs", throwing)).toBe(true);
    expect(() => writePanelOpen("motifs", false, throwing)).not.toThrow();
    const junk = memory();
    junk.setItem("achi.panels", "{not json");
    expect(readPanelOpen("motifs", junk)).toBe(true);
    writePanelOpen("motifs", false, junk);
    expect(readPanelOpen("motifs", junk)).toBe(false);
  });
});
