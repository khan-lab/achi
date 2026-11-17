import { useEffect, useRef } from "react";
import { useStore } from "../state/store";
import type { ParsedLink } from "../lib/shareLink";

const OVERLAP: Record<string, string> = {
  "1bp": "any overlap (1 bp)",
  fraction50: "at least 50% of a region",
  reciprocal50: "at least 50% reciprocal",
};

function settingsSummary(link: ParsedLink): string[] {
  const s = link.settings;
  const out: string[] = [];
  if (s.assembly) out.push(`assembly ${s.assembly}`);
  if (s.advanced) out.push(`bedtools options ${s.advanced}`);
  else if (s.overlapPreset) out.push(`overlap: ${OVERLAP[s.overlapPreset]}`);
  if (s.blacklistFilter) out.push("ENCODE blacklist filter on");
  if (s.pairwiseStat && s.pairwiseStat !== "jaccard") out.push(`pairwise ${s.pairwiseStat}`);
  return out;
}

/**
 * Asks before downloading the public files an "Open in Intervene Secure"
 * link names (lib/shareLink.ts). Nothing is fetched until the user agrees.
 */
export function LinkDialog() {
  const link = useStore((s) => s.linkRequest);
  const acceptLink = useStore((s) => s.acceptLink);
  const declineLink = useStore((s) => s.declineLink);
  const loaded = useStore((s) => s.sets.length);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (link && d && !d.open) d.showModal();
  }, [link]);

  if (!link) return null;
  const hosts = [...new Set(link.files.map((f) => f.host))];
  const summary = settingsSummary(link);
  const n = link.files.length;
  const lists = link.mode === "lists";
  const what = `${n === 1 ? "one" : n} public ${lists ? (n === 1 ? "list of names" : "lists of names") : n === 1 ? "region file" : "region files"}`;

  return (
    <dialog
      ref={ref}
      className="linkdialog"
      aria-labelledby="linkdialog-title"
      onCancel={(e) => {
        e.preventDefault();
        declineLink();
      }}
    >
      <h2 id="linkdialog-title">Open the files in this link?</h2>
      <p>
        This link asks to download {what} and compare {n === 1 ? "it" : "them"}. Your browser downloads {n === 1 ? "it" : "them"} directly from {hosts.length === 1 ? hosts[0] : `${hosts.length} servers`}; {hosts.length === 1 ? "that server" : "each server"} sees a download, as
        from any web page. Nothing else is sent, and nothing you load from your computer leaves it.
      </p>
      <ol className="linkdialog-files">
        {link.files.map((f) => (
          <li key={f.url}>
            <strong>{f.name ?? f.fileName}</strong> <span className="linkdialog-host">{f.host}</span>
            <code>{f.url}</code>
          </li>
        ))}
      </ol>
      {loaded > 0 && (
        <p className="linkdialog-note">
          {loaded === 1 ? "The set loaded now is" : `The ${loaded} sets loaded now are`} replaced by these.
        </p>
      )}
      {summary.length > 0 && <p className="linkdialog-note">The link also set: {summary.join("; ")}.</p>}
      {link.problems.length > 0 && (
        <ul className="linkdialog-problems">
          {link.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="linkdialog-actions">
        <button className="ghost primary" autoFocus onClick={() => void acceptLink()}>
          Download and compare
        </button>
        <button className="ghost" onClick={declineLink}>
          Don't download
        </button>
      </div>
    </dialog>
  );
}
