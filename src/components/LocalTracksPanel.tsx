import { useRef } from "react";
import type { LocalReference, LocalTrack } from "../lib/localTracks";

/**
 * Local tracks for the genome browser: files from the user's disk, read in
 * this page only (lib/localTracks.ts). Added with the button or by dropping
 * files on the genome browser; kept for this page session. BAM and CRAM
 * are selected together with their index; a CRAM also needs the reference
 * FASTA (+ .fai) it was made with, listed here once loaded.
 */

const ACCEPT = ".bw,.bigwig,.bb,.bigbed,.bed,.narrowPeak,.broadPeak,.bedGraph,.bdg,.vcf,.gz,.bam,.bai,.cram,.crai,.fa,.fasta,.fna,.fai";
const LABEL: Record<LocalTrack["format"], string> = {
  bigwig: "bigWig",
  bigbed: "bigBed",
  bed: "BED",
  narrowpeak: "narrowPeak",
  broadpeak: "broadPeak",
  bedgraph: "bedGraph",
  vcf: "VCF",
  bam: "BAM",
  cram: "CRAM",
};
const KIND_NOTE: Record<LocalTrack["kind"], string> = {
  signal: " · signal, genome browser only",
  alignment: " · alignments, shown when zoomed in",
  annotation: "",
};

export function LocalTracksPanel({
  tracks,
  reference,
  busy,
  errors,
  onFiles,
  onRemove,
  onRemoveReference,
}: {
  tracks: LocalTrack[];
  reference: LocalReference | null;
  busy: boolean;
  errors: string[];
  onFiles: (files: File[]) => void;
  onRemove: (id: string) => void;
  onRemoveReference: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="gb-local">
      <div className="gb-local-row">
        <button className="ghost" type="button" disabled={busy} onClick={() => input.current?.click()}>
          Add local tracks…
        </button>
        <span className="hint">
          {busy
            ? "Reading…"
            : "bigWig, bigBed, BED, narrowPeak, bedGraph, VCF, BAM + .bai, or CRAM + .crai with its reference .fa + .fai, from your disk or dropped here; read in this page only."}
        </span>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          aria-label="Local track files"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length) onFiles(files);
          }}
        />
      </div>
      {errors.map((m) => (
        <div key={m} className="hint error">
          {m}
        </div>
      ))}
      {(tracks.length > 0 || reference) && (
        <ul className="gb-local-list">
          {reference && (
            <li>
              <span className="gb-local-name">{reference.name}</span> <span className="hint">reference FASTA for CRAM tracks</span>
              <button className="linkbtn" type="button" aria-label={`Remove ${reference.name}`} onClick={onRemoveReference}>
                remove
              </button>
              {reference.warnings.map((w) => (
                <div key={w} className="gb-local-warn">
                  {w}
                </div>
              ))}
            </li>
          )}
          {tracks.map((t) => (
            <li key={t.id}>
              <span className="gb-local-name">{t.name}</span> <span className="hint">
                {LABEL[t.format]}
                {KIND_NOTE[t.kind]}
              </span>
              <button className="linkbtn" type="button" aria-label={`Remove ${t.name}`} onClick={() => onRemove(t.id)}>
                remove
              </button>
              {t.warnings.map((w) => (
                <div key={w} className="gb-local-warn">
                  {w}
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
