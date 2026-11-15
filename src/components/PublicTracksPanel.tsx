import { useEffect, useMemo, useState } from "react";
import {
  CONSENT_HOSTS,
  consentedHosts,
  encodeSearchUrl,
  hostOf,
  parseEncodeSearch,
  parseTrackInput,
  remoteTracksUrl,
  urlTrack,
  type RemoteTrack,
  type RemoteTrackList,
} from "../lib/remoteTracks";

/**
 * Public tracks for the genome browser (ENCODE, SCREEN, or a pasted
 * bigWig/bigBed URL). Nothing here contacts another server until the user
 * agrees; the agreement lasts for this page session only (kept in memory,
 * never stored), and covers the hosts listed in the notice. A pasted URL on
 * any other host needs its own confirmation. See lib/remoteTracks.ts.
 */

const BASE = `${window.location.origin}${import.meta.env.BASE_URL}`;

const listCache = new Map<string, Promise<RemoteTrackList | null>>();
function loadList(assembly: string): Promise<RemoteTrackList | null> {
  let p = listCache.get(assembly);
  if (!p) {
    // The list is the app's own file (no outside request); mm9 has none.
    p = fetch(remoteTracksUrl(assembly, BASE)).then((r) => (r.ok ? (r.json() as Promise<RemoteTrackList>) : null));
    listCache.set(assembly, p);
  }
  return p;
}

const fmtSize = (n?: number) => (n === undefined ? "" : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

export function PublicTracksPanel({ assembly, chosen, onChange }: { assembly: string; chosen: RemoteTrack[]; onChange: (tracks: RemoteTrack[]) => void }) {
  const [consented, setConsented] = useState(() => CONSENT_HOSTS.every((h) => consentedHosts.has(h.host)));
  const [asking, setAsking] = useState(false);
  const [list, setList] = useState<RemoteTrackList | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [results, setResults] = useState<RemoteTrack[] | null>(null);
  const [pendingUrl, setPendingUrl] = useState<RemoteTrack | null>(null);

  useEffect(() => {
    setList(null);
    void loadList(assembly).then(setList);
  }, [assembly]);

  const chosenIds = useMemo(() => new Set(chosen.map((t) => t.id)), [chosen]);
  // Cell-line groups ("ENCODE: GM12878", names "GM12878 H3K27ac") become one table: cell lines x assays.
  const { groups, cells, assays } = useMemo(() => {
    const g = new Map<string, RemoteTrack[]>();
    const cellRows = new Map<string, Map<string, RemoteTrack>>();
    const assayCols: string[] = [];
    for (const t of list?.tracks ?? []) {
      if (t.group.startsWith("ENCODE: ")) {
        const cell = t.group.slice("ENCODE: ".length);
        const assay = t.name.slice(cell.length + 1);
        if (!assayCols.includes(assay)) assayCols.push(assay);
        cellRows.set(cell, (cellRows.get(cell) ?? new Map()).set(assay, t));
      } else g.set(t.group, [...(g.get(t.group) ?? []), t]);
    }
    return { groups: [...g.entries()], cells: [...cellRows.entries()], assays: assayCols };
  }, [list]);
  const curatedIds = useMemo(() => new Set(list?.tracks.map((t) => t.id)), [list]);
  const extra = chosen.filter((t) => !curatedIds.has(t.id));

  const add = (t: RemoteTrack) => !chosenIds.has(t.id) && onChange([...chosen, t]);
  const remove = (id: string) => onChange(chosen.filter((t) => t.id !== id));
  const toggle = (t: RemoteTrack) => (chosenIds.has(t.id) ? remove(t.id) : add(t));

  function agree() {
    for (const h of CONSENT_HOSTS) consentedHosts.add(h.host);
    setConsented(true);
    setAsking(false);
  }

  function stop() {
    consentedHosts.clear();
    onChange([]);
    setConsented(false);
    setResults(null);
    setPendingUrl(null);
    setMessage(null);
  }

  async function encode(q: { term: string } | { accession: string }) {
    setBusy(true);
    setMessage(null);
    setResults(null);
    try {
      const r = await fetch(encodeSearchUrl(q, assembly), { headers: { Accept: "application/json" } });
      // ENCODE answers a search with no hits with HTTP 404 and an empty @graph.
      const json: unknown = r.status === 404 ? { "@graph": [] } : await r.json();
      if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`);
      const { tracks, skipped } = parseEncodeSearch(json, assembly);
      if ("accession" in q) {
        if (tracks.length) {
          add(tracks[0]);
          setMessage(`Added ${tracks[0].id}: ${tracks[0].name}.`);
        } else setMessage(skipped.length ? `${skipped[0].accession} ${skipped[0].reason}.` : `${q.accession}: no such released file.`);
      } else {
        setResults(tracks);
        if (!tracks.length) setMessage(`No released bigWig or bigBed files on ${assembly} match “${q.term}”.`);
      }
    } catch (e) {
      setMessage(`ENCODE could not be reached: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    const p = parseTrackInput(input);
    setPendingUrl(null);
    if ("error" in p) {
      setMessage(p.error);
      return;
    }
    if (p.kind === "accession") void encode({ accession: p.accession });
    else if (p.kind === "search") void encode({ term: p.term });
    else {
      const t = urlTrack(p.url, p.format);
      if (consentedHosts.has(hostOf(p.url))) {
        add(t);
        setMessage(`Added ${t.name}.`);
      } else setPendingUrl(t);
    }
  }

  if (!consented) {
    return (
      <div className="gb-public">
        {!asking ? (
          <button className="ghost" onClick={() => setAsking(true)}>
            Add public tracks (ENCODE, SCREEN)…
          </button>
        ) : (
          <div className="gb-consent" role="dialog" aria-label="Public tracks consent">
            <p>
              <strong>Public tracks are read from other servers while you browse.</strong> Those servers will see which
              genomic regions you look at (and your IP address). Nothing from your own files is sent.
            </p>
            <ul>
              {CONSENT_HOSTS.map((h) => (
                <li key={h.host}>
                  <code>{h.host}</code>: {h.what}
                </li>
              ))}
            </ul>
            <p className="hint">This applies until you close or reload the page, or press “Stop public tracks”.</p>
            <div className="gb-consent-actions">
              <button className="ghost" onClick={agree}>
                Allow for this session
              </button>
              <button className="ghost" onClick={() => setAsking(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <details className="gb-public gb-refs" open>
      <summary>
        Public tracks <span className="railcount">{chosen.length ? `${chosen.length} shown` : "on"}</span>
      </summary>

      {groups.map(([group, tracks]) => (
        <div key={group} className="gb-group">
          <div className="gb-group-hd">{group}</div>
          <div className="gb-refgrid">
            {tracks.map((t) => (
              <label key={t.id} className="gb-ref" title={`${t.description} ${fmtSize(t.size)}`}>
                <input type="checkbox" checked={chosenIds.has(t.id)} onChange={() => toggle(t)} /> {t.name}
              </label>
            ))}
          </div>
        </div>
      ))}
      {cells.length > 0 && (
        <div className="gb-group">
          <div className="gb-group-hd">ENCODE signal, example data's cell lines</div>
          <table className="gb-matrix">
            <thead>
              <tr>
                <th />
                {assays.map((a) => (
                  <th key={a}>{a}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cells.map(([cell, byAssay]) => (
                <tr key={cell}>
                  <th scope="row">{cell}</th>
                  {assays.map((a) => {
                    const t = byAssay.get(a);
                    return (
                      <td key={a}>
                        {t && (
                          <input
                            type="checkbox"
                            aria-label={t.name}
                            title={`${t.name}: ${t.description} ${fmtSize(t.size)}`}
                            checked={chosenIds.has(t.id)}
                            onChange={() => toggle(t)}
                          />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list === null && <div className="hint">No curated public tracks for {assembly}; search ENCODE or paste a URL.</div>}

      <form
        className="gb-toolbar"
        style={{ marginTop: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          className="gb-locus"
          aria-label="Search ENCODE, or paste an ENCODE accession or a bigWig/bigBed URL"
          placeholder="Search ENCODE (e.g. HepG2 CTCF), ENCFF… or a bigWig/bigBed URL"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="ghost" type="submit" disabled={busy}>
          {busy ? "…" : "Add / search"}
        </button>
      </form>

      {pendingUrl && (
        <div className="gb-consent">
          <p>
            Add <strong>{pendingUrl.name}</strong> from <code>{hostOf(pendingUrl.url)}</code>? That server will see which
            regions you view, for as long as the track is shown.
          </p>
          <div className="gb-consent-actions">
            <button
              className="ghost"
              onClick={() => {
                consentedHosts.add(hostOf(pendingUrl.url));
                add(pendingUrl);
                setMessage(`Added ${pendingUrl.name}.`);
                setPendingUrl(null);
              }}
            >
              Add
            </button>
            <button className="ghost" onClick={() => setPendingUrl(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {message && <div className="hint">{message}</div>}

      {results && results.length > 0 && (
        <div className="gb-results">
          {results.map((t) => (
            <div key={t.id} className="gb-result">
              <span>
                <span className="mono">{t.id}</span> {t.name} <span className="hint">{fmtSize(t.size)}</span>
              </span>
              <button className="linkbtn" disabled={chosenIds.has(t.id)} onClick={() => add(t)}>
                {chosenIds.has(t.id) ? "added" : "add"}
              </button>
            </div>
          ))}
        </div>
      )}

      {extra.length > 0 && (
        <div className="gb-group">
          <div className="gb-group-hd">Added</div>
          {extra.map((t) => (
            <div key={t.id} className="gb-result">
              <span>
                {t.name} <span className="hint">{hostOf(t.url)}</span>
              </span>
              <button className="linkbtn" onClick={() => remove(t.id)}>
                remove
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="gb-consent-actions" style={{ marginTop: 8 }}>
        <button className="ghost" onClick={stop}>
          Stop public tracks
        </button>
        <span className="hint">
          Shown tracks are read from {[...new Set(chosen.map((t) => hostOf(t.url)))].join(", ") || "no server yet"}.
        </span>
      </div>
    </details>
  );
}
