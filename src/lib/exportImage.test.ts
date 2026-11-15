import { describe, expect, it } from "vitest";
import { svgDimensions } from "./exportImage";

describe("svgDimensions", () => {
  it("reads the root width and height of an SVG string (as igv.js's toSVG writes it)", () => {
    expect(svgDimensions('<svg xmlns="http://www.w3.org/2000/svg" width="1037" height="812.5" viewBox="0 0 1037 812.5"><g/></svg>')).toEqual({ width: 1037, height: 812.5 });
    expect(svgDimensions('<?xml version="1.0"?><svg viewBox="0 0 300 150"></svg>')).toEqual({ width: 300, height: 150 });
  });
  it("returns null when neither is present", () => {
    expect(svgDimensions("<svg></svg>")).toBeNull();
    expect(svgDimensions("not svg")).toBeNull();
  });
});
