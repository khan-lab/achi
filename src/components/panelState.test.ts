import { describe, expect, it } from "vitest";
import { isOpen, setPanelsOpen } from "./panelState";

/**
 * Before anything is selected the panels "wait": folded unless opened while
 * waiting. Opening or folding is remembered for after a selection too.
 */
describe("panel open state while waiting for a selection", () => {
  it("waits folded, while the same panel with a selection is open by default", () => {
    expect(isOpen("w-a", true)).toBe(false);
    expect(isOpen("w-a")).toBe(true);
  });
  it("a panel opened while waiting stays open, and folding it is remembered once something is selected", () => {
    setPanelsOpen(["w-b"], true);
    expect(isOpen("w-b", true)).toBe(true);
    setPanelsOpen(["w-b"], false);
    expect(isOpen("w-b", true)).toBe(false);
    expect(isOpen("w-b")).toBe(false);
  });
  it("Expand all while waiting opens every listed panel in both states", () => {
    setPanelsOpen(["w-c", "w-d"], true);
    expect(["w-c", "w-d"].map((id) => [isOpen(id, true), isOpen(id)])).toEqual([
      [true, true],
      [true, true],
    ]);
  });
});
