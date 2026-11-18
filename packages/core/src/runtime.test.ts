import { describe, expect, it } from "vitest";
import { abortIfCancelled, isDoneFor, loadRefText, onceFor, type Bedtools } from "./runtime";

const bedtools = (): Bedtools => ({ dir: "/d", mount: async () => {}, unmount: async () => {}, exec: async () => ({ stdout: "", stderr: "" }), reset: async () => {} });

describe("onceFor", () => {
  it("runs the load once per owner and key, sharing it between concurrent callers", async () => {
    const a = bedtools();
    const b = bedtools();
    let runs = 0;
    const load = async () => `path-${++runs}`;
    const [x, y] = await Promise.all([onceFor(a, "genes:hg38", load), onceFor(a, "genes:hg38", load)]);
    expect([x, y]).toEqual(["path-1", "path-1"]);
    expect(await onceFor(a, "genes:hg38", load)).toBe("path-1");
    expect(await onceFor(a, "genes:mm10", load)).toBe("path-2");
    expect(await onceFor(b, "genes:hg38", load)).toBe("path-3"); // another owner (bedtools) has its own
    expect(isDoneFor(a, "genes:hg38")).toBe(true);
    expect(isDoneFor(b, "genes:mm10")).toBe(false);
  });

  it("forgets a failed load, so the next call tries again", async () => {
    const a = bedtools();
    await expect(onceFor(a, "k", async () => Promise.reject(new Error("offline")))).rejects.toThrow("offline");
    expect(isDoneFor(a, "k")).toBe(false);
    expect(await onceFor(a, "k", async () => "ok")).toBe("ok");
  });
});

describe("loadRefText and abortIfCancelled", () => {
  it("names the file in the error, with the reason as its cause", async () => {
    const err = await loadRefText({ refdata: { text: async () => Promise.reject(new Error("HTTP 404")) } }, "refdata/x.bed", "x.bed").catch((e: Error) => e);
    expect(err).toMatchObject({ message: "Could not load x.bed" });
    expect((err as Error).cause).toMatchObject({ message: "HTTP 404" });
  });
  it("throws an AbortError only once the run is cancelled", () => {
    expect(() => abortIfCancelled(undefined)).not.toThrow();
    expect(() => abortIfCancelled(new AbortController().signal)).not.toThrow();
    expect(() => abortIfCancelled(AbortSignal.abort())).toThrow(expect.objectContaining({ name: "AbortError" }));
  });
});
