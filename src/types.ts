/**
 * Web-app types. The data shapes shared with the CLI and MCP server live in
 * @achi/core/types and are re-exported here.
 */
export type { Interval, RegionSet, Subset } from "@achi/core/types";
export { MAX_SETS } from "@achi/core/types";

/**
 * One colour per set slot, assigned in this fixed order and never cycled
 * (PALETTE.length >= MAX_SETS; see types.test.ts). In the UpSet matrix every
 * set's colour sits side by side, so the palette was chosen to keep *every*
 * pair apart, not just neighbours: checked with the dataviz skill's
 * validate_palette.js (`--mode light --pairs all`, on #fcfcfb and #ffffff),
 * all checks pass — worst pair under protan/deutan simulation ΔE 8.8
 * (coral/teal; target >= 8), worst pair for normal vision ΔE 17.5 (floor 15),
 * every colour >= 3:1 against the plot background, OKLCH lightness and
 * chroma in band. The previous 6-colour palette failed this: olive #5F7A14
 * and orange #C2611A were ΔE 1.3 apart under protanopia. Slot 1 blue is
 * unchanged. Set names and 3-letter codes always accompany the colour.
 * Light theme only (the app never sets data-theme="dark").
 */
export const PALETTE = [
  "#2B6FE0", // blue
  "#A97416", // ochre
  "#049F80", // teal
  "#6C1BB9", // purple
  "#F8546E", // coral
  "#356312", // green
  "#8D3B63", // mauve
  "#AB78C1", // lilac
];
