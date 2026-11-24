/**
 * How the achi command looks on a terminal: colour (Node's util.styleText,
 * no dependency) and a live progress line on stderr. Colour follows
 * no-color.org (NO_COLOR, FORCE_COLOR, --no-color) and is otherwise on only
 * for a terminal; the live line is shown only when stderr is a terminal.
 * Piped output, logs and -q stay plain text. Presentation only: nothing here
 * changes what is computed or written.
 */
import { styleText } from "node:util";

type Format = Parameters<typeof styleText>[0];
export type Paint = (format: Format, text: string) => string;

/** Whether to colour a stream: --no-color, then NO_COLOR (any non-empty value), then FORCE_COLOR (not "0"), then a terminal that is not "dumb". */
export function colorWanted(tty: boolean | undefined, env: Record<string, string | undefined>, flag?: boolean): boolean {
  if (flag === false) return false;
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
  return !!tty && env.TERM !== "dumb";
}

/** Styling that is a no-op when colour is off. We decide when to colour, so styleText's own stream check is off. */
export function painter(on: boolean): Paint {
  return on ? (format, text) => styleText(format, text, { validateStream: false }) : (_format, text) => text;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

export interface ProgressEvent {
  /** The analysis: "Intersections", "Motif enrichment", ... */
  section: string;
  /** What it is doing now. */
  label: string;
  done?: number;
  total?: number;
  unit?: string;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BAR = 20;
const CLEAR = "\r\x1b[2K";
const n = (x: number) => x.toLocaleString("en-US");

/** 4.2s under a minute, 1:05 above. */
export function duration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/**
 * One live line for the current stage (spinner, stage, step, bar,
 * done/total, time, time left), rewritten in place; when the next stage
 * starts the line becomes "✓ stage  time". Notes print above the line.
 */
export class LiveProgress {
  private section: string | null = null;
  private started = 0;
  private last: ProgressEvent | null = null;
  private frame = 0;
  private lastRender = -Infinity;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly o: { write: (s: string) => void; paint: Paint; columns: () => number; now?: () => number; animate?: boolean };

  constructor(o: { write: (s: string) => void; paint: Paint; columns: () => number; now?: () => number; animate?: boolean }) {
    this.o = o;
    this.now = o.now ?? (() => performance.now());
  }

  update(e: ProgressEvent): void {
    const newSection = e.section !== this.section;
    if (newSection) {
      this.finishSection("✓");
      this.section = e.section;
      this.started = this.now();
      this.startTimer();
    }
    this.last = e;
    // Some steps report thousands of times a second; redraw at most every 50 ms.
    if (newSection || this.now() - this.lastRender >= 50 || e.done === e.total) this.render();
  }

  note(line: string, kind?: "warn"): void {
    const p = this.o.paint;
    this.o.write(`${CLEAR}${kind === "warn" ? `${p("yellow", "!")} ${line}` : p("dim", `  ${line}`)}\n`);
    if (this.section) this.render();
  }

  /** The run finished: tick off the last stage. */
  done(): void {
    this.finishSection("✓");
    this.stopTimer();
  }

  /** A stage finished: tick it off now rather than when the next starts. */
  stageDone(section: string): void {
    if (section === this.section) this.finishSection("✓");
  }

  /** The run stopped with an error: mark the unfinished stage ✗ and leave a clean line for the message. */
  fail(): void {
    this.finishSection("✗");
    this.stopTimer();
  }

  private finishSection(mark: "✓" | "✗"): void {
    if (!this.section) return;
    const p = this.o.paint;
    const time = mark === "✓" ? `  ${p("dim", duration(this.now() - this.started))}` : "";
    this.o.write(`${CLEAR}${mark === "✓" ? p("green", mark) : p("red", mark)} ${p("bold", this.section)}${time}\n`);
    this.section = null;
    this.last = null;
  }

  private render(): void {
    const e = this.last;
    if (!e || !this.section) return;
    const p = this.o.paint;
    this.lastRender = this.now();
    const elapsed = this.now() - this.started;
    const known = e.total !== undefined && e.total > 0 && e.done !== undefined;
    const done = Math.min(e.done ?? 0, e.total ?? 0);
    const filled = known ? Math.round((done / e.total!) * BAR) : 0;
    const counts = known ? `${n(done)}/${n(e.total!)}${e.unit ? ` ${e.unit}` : ""}` : "";
    const left = known && done > 0 && done < e.total! && elapsed > 1000 ? `  ~${duration((elapsed * (e.total! - done)) / done)} left` : "";
    const spinner = FRAMES[this.frame % FRAMES.length];

    // Plain widths first, so the label alone is shortened to fit the terminal.
    const showLabel = e.label !== e.section;
    const head = `${spinner} ${e.section}${showLabel ? " · " : ""}`;
    const tail = `${known ? `  ${"█".repeat(filled)}${"░".repeat(BAR - filled)} ${counts}` : ""}  ${duration(elapsed)}${left}`;
    const room = Math.max(1, this.o.columns() - 1 - head.length - tail.length);
    const label = !showLabel ? "" : e.label.length > room ? `${e.label.slice(0, Math.max(0, room - 1))}…` : e.label;

    const bar = known ? `  ${p("cyan", "█".repeat(filled))}${p("dim", "░".repeat(BAR - filled))} ${counts}` : "";
    this.o.write(`${CLEAR}${p("cyan", spinner)} ${p("bold", e.section)}${showLabel ? ` ${p("dim", "·")} ${label}` : ""}${bar}  ${p("dim", duration(elapsed) + left)}`);
  }

  private startTimer(): void {
    if (this.o.animate === false || this.timer) return;
    this.timer = setInterval(() => {
      this.frame++;
      this.render();
    }, 100);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
