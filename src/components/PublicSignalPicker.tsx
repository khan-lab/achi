import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { hostOf, parseTrackInput, remoteTracksUrl, type RemoteTrack, type RemoteTrackList } from "../lib/remoteTracks";
import { signalConsentHosts } from "../lib/remoteSignal";

/**
 * Adds public bigWigs to the signal-profile card: the genome browser's
 * curated list for the assembly (this site's own file, no outside request)
 * or a pasted https URL. Asks once per page session, per host, before any
 * of them is read; nothing is fetched here, only when profiles are computed.
 */
export function PublicSignalPicker({ onClose }: { onClose: () => void }) {
  const assembly = useStore((s) => s.assembly);
  const addPublicSignal = useStore((s) => s.addPublicSignal);
  const [list, setList] = useState<RemoteTrack[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pasted, setPasted] = useState("");
  const [asking, setAsking] = useState<RemoteTrack[] | null>(null);

  useEffect(() => {
    let live = true;
    fetch(remoteTracksUrl(assembly, import.meta.env.BASE_URL))
      .then((r) => (r.ok ? (r.json() as Promise<RemoteTrackList>) : Promise.reject(new Error(`No public tracks are listed for ${assembly}.`))))
      .then((l) => live && setList(l.tracks.filter((t) => t.kind === "bigwig")))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [assembly]);

  const groups = [...new Set((list ?? []).map((t) => t.group))];
  const add = (tracks: RemoteTrack[]) => {
    const unknown = [...new Set(tracks.map((t) => hostOf(t.url)))].filter((h) => !signalConsentHosts.has(h));
    if (unknown.length) {
      setAsking(tracks);
      return;
    }
    addPublicSignal(tracks.map((t) => ({ name: t.name, url: t.url })));
    onClose();
  };
  const pastedTrack = (): RemoteTrack | null => {
    const p = parseTrackInput(pasted);
    if ("error" in p) {
      setError(p.error);
      return null;
    }
    if (p.kind !== "url" || p.format !== "bigwig") {
      setError("Paste the https address of a bigWig file (.bw or .bigWig).");
      return null;
    }
    const name = decodeURIComponent(new URL(p.url).pathname.split("/").pop() ?? p.url).replace(/\.(bw|bigwig)$/i, "");
    return { id: p.url, group: "Pasted", name, kind: "bigwig", url: p.url, source: p.url, description: "" };
  };

  if (asking) {
    const hosts = [...new Set(asking.map((t) => hostOf(t.url)))];
    return (
      <div className="gb-consent sp-picker" role="dialog" aria-label="Public signal consent">
        <p>
          <strong>Public tracks are read from their servers:</strong> {hosts.join(", ")}.
        </p>
        <p>
          By default (<em>private</em>) the card downloads a whole-genome summary of each file, the same download whatever
          your regions, so a server learns only that this browser downloaded it. <em>Exact</em> reading, if you choose it,
          tells the server roughly where your regions are, and asks again every time. Your files are never sent.
        </p>
        <div className="gb-consent-actions">
          <button
            className="ghost primary"
            onClick={() => {
              hosts.forEach((h) => signalConsentHosts.add(h));
              addPublicSignal(asking.map((t) => ({ name: t.name, url: t.url })));
              onClose();
            }}
          >
            Agree and add
          </button>
          <button className="ghost" onClick={() => setAsking(null)}>
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="gb-consent sp-picker" aria-label="Public signal tracks">
      <p>Public bigWigs, as in the genome browser. Nothing is downloaded until you compute profiles.</p>
      {error && <div className="hint error">{error}</div>}
      {!list && !error && <div className="setinfo">Loading the list…</div>}
      <div className="sp-picker-list">
        {groups.map((g) => (
          <fieldset key={g} className="sp-picker-group">
            <legend>{g}</legend>
            {list!
              .filter((t) => t.group === g)
              .map((t) => (
                <label key={t.id} className="checkrow" title={`${t.description} ${hostOf(t.url)}${t.size ? ` · ${(t.size / 1e9).toFixed(1)} GB` : ""}`}>
                  <input
                    type="checkbox"
                    checked={picked.has(t.id)}
                    onChange={() =>
                      setPicked((p) => {
                        const n = new Set(p);
                        if (n.has(t.id)) n.delete(t.id);
                        else n.add(t.id);
                        return n;
                      })
                    }
                  />
                  <span className="k">{t.name}</span>
                </label>
              ))}
          </fieldset>
        ))}
      </div>
      <label className="param" style={{ marginTop: 6 }}>
        <span className="k">Or a bigWig URL</span>
        <input className="param-text sp-url" type="url" placeholder="https://…/signal.bigWig" value={pasted} onChange={(e) => (setPasted(e.target.value), setError(null))} aria-label="bigWig URL" />
      </label>
      <div className="gb-consent-actions" style={{ marginTop: 8 }}>
        <button
          className="ghost primary"
          disabled={!picked.size && !pasted.trim()}
          onClick={() => {
            const chosen = (list ?? []).filter((t) => picked.has(t.id));
            if (pasted.trim()) {
              const p = pastedTrack();
              if (!p) return;
              chosen.push(p);
            }
            add(chosen);
          }}
        >
          Add
        </button>
        <button className="ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
