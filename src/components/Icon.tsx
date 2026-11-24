/**
 * Small line icons for icon buttons. Inline SVG instead of text glyphs
 * (⬇ ◉ ○ ⧉ ✕ ↺ ✓): each glyph sits on its font's baseline with its own side
 * bearings, so no CSS centres them consistently. Every icon here is drawn on
 * the same 16×16 grid, centred, and inherits the button's text colour.
 */
export type IconName = "download" | "copy" | "check" | "close" | "reset" | "included" | "excluded" | "panelClose" | "panelOpen" | "chevronUp" | "chevronDown" | "collapseAll" | "expandAll" | "railClose" | "railOpen";

const PATHS: Record<IconName, React.ReactNode> = {
  download: (
    <>
      <path d="M8 2.5v8" />
      <path d="M4.5 7.5 8 11l3.5-3.5" />
      <path d="M3 13.5h10" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5v-.5a1 1 0 0 0-1-1H4a1.5 1.5 0 0 0-1.5 1.5v5.5a1 1 0 0 0 1 1h.5" />
    </>
  ),
  check: <path d="m3.5 8.5 3 3 6-7" />,
  close: (
    <>
      <path d="m4 4 8 8" />
      <path d="m12 4-8 8" />
    </>
  ),
  reset: (
    <>
      <path d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2" />
      <path d="M3.5 2.5v2.8h2.8" />
    </>
  ),
  included: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="2.75" fill="currentColor" stroke="none" />
    </>
  ),
  excluded: <circle cx="8" cy="8" r="5.5" />,
  // Side column: chevrons pointing the way the column moves (out to the right / back in).
  panelClose: <path d="m6 3.5 4.5 4.5L6 12.5" />,
  panelOpen: <path d="M10 3.5 5.5 8l4.5 4.5" />,
  // Left column: the same chevrons, mirrored (back out to the left / in).
  railClose: <path d="M10 3.5 5.5 8l4.5 4.5" />,
  railOpen: <path d="m6 3.5 4.5 4.5L6 12.5" />,
  // Middle-column panels: fold up / unfold down.
  chevronUp: <path d="M3.5 10 8 5.5l4.5 4.5" />,
  chevronDown: <path d="M3.5 6 8 10.5 12.5 6" />,
  // All panels: chevrons closing in / opening out.
  collapseAll: (
    <>
      <path d="M4.5 2.5 8 6l3.5-3.5" />
      <path d="M4.5 13.5 8 10l3.5 3.5" />
    </>
  ),
  expandAll: (
    <>
      <path d="M4.5 6 8 2.5 11.5 6" />
      <path d="M4.5 10 8 13.5l3.5-3.5" />
    </>
  ),
};

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
