'use client';
import TimelinePlayer from './TimelinePlayer';
import { parseCoords } from '../../lib/coords';
import { FeedbackStyles, Radar, Bar, useElapsed, fmtEta } from './Feedback';
import { useFrameStore, progress } from '../../lib/frameStore';

import { memo, useCallback, useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    A?: any;
  }
}

// Notifies when it enters/leaves the strip's visible area (with ~3 thumbnails of margin)
function LazyCell({
  rootRef,
  onEnter,
  onLeave,
  onClick,
  className,
  children,
}: {
  rootRef: React.RefObject<HTMLDivElement | null>;
  onEnter: () => void;
  onLeave: () => void;
  onClick: () => void;
  className: string;
  children: React.ReactNode;
}) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const cb = useRef({ onEnter, onLeave });
  cb.current = { onEnter, onLeave };

  useEffect(() => {
    const el = elRef.current;
    const root = rootRef.current;
    if (!el || !root) return;
    const io = new IntersectionObserver(
      ([e]) => (e.isIntersecting ? cb.current.onEnter() : cb.current.onLeave()),
      { root, rootMargin: '0px 320px 0px 320px', threshold: 0 }
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={elRef} onClick={onClick} className={className}>
      {children}
    </div>
  );
}

const CHALLENGE_TARGETS = [
  { name: "Barnard's Star", ra: '269.452075', dec: '4.693391' },
  { name: 'WISE 0855', ra: '133.795129', dec: '-7.245147' },
  { name: 'Epsilon Indi B', ra: '330.840225', dec: '-56.785983' },
  { name: 'RW Aurigae', ra: '76.956542', dec: '30.401444' },
  { name: 'R Draconis', ra: '248.163292', dec: '66.754722' },
];

// "Field" = frame cutout size (degrees). The map shows 3x this value.
const FOV_OPTIONS = [0.08, 0.16, 0.24, 0.4];
const FOV_MIN = 0.04;
const FOV_MAX = 0.6;

// Angular separation between two sky points (degrees)
const sepDeg = (ra1: number, dec1: number, ra2: number, dec2: number) => {
  const r = Math.PI / 180;
  const a = Math.sin(((dec2 - dec1) * r) / 2) ** 2 + Math.cos(dec1 * r) * Math.cos(dec2 * r) * Math.sin(((ra2 - ra1) * r) / 2) ** 2;
  return ((2 * Math.asin(Math.min(1, Math.sqrt(a)))) / r);
};

const noteFrom = (dbg: any): string => {
  const info = (dbg?.attempts || []).find((a: any) => a.status === 'info');
  return [dbg?.source ? `Source: ${dbg.source}` : '', info?.note || '', dbg?.error || ''].filter(Boolean).join(' · ');
};
const MAP_FOV_FACTOR = 3;
const SEARCH_RADIUS = 0.05;
const MAX_PARALLEL = 4;

const ALADIN_SRC = '/aladin.js';
const SURVEYS = [
  { id: 'dss', label: 'DSS2 color (optical)', url: 'https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/color' },
];
const surveyUrl = (id: string) => (SURVEYS.find((s) => s.id === id) ?? SURVEYS[0]).url;
type TileStatus = 'loading' | 'ok' | 'nocoverage' | 'error';
type TileState = { status: TileStatus; src?: string; message?: string };
type Center = { ra: string; dec: string; fov: number };
type View = { s: number; x: number; y: number };
type LogLevel = 'info' | 'ok' | 'warn' | 'error';
type LogEntry = { t: string; level: LogLevel; text: string };
type Phase = 'idle' | 'searching' | 'rendering' | 'done' | 'error';
type MapState = 'loading' | 'ready' | 'error';
type Mode = 'map' | 'frame' | 'video';

type SavedPoint = { id: string; name: string; ra: string; dec: string; fov: number };
const SAVED_KEY = 'spherex-saved-points';

const frameKey = (f: any): string => f?.access_url || f?.accessUrl || f?.url || f?.fileUrl || '';
const shortName = (key: string) => (key.split('?')[0].split('/').pop() || key).slice(-34);

const buildPngUrl = (frame: any, c: Center) => {
  const raw = frameKey(frame);
  if (!raw) return '';
  return `/api/align?url=${encodeURIComponent(raw)}&ra=${c.ra}&dec=${c.dec}&fov=${c.fov}&format=png`;
};

const LOG_COLORS: Record<LogLevel, string> = {
  info: 'text-gray-400',
  ok: 'text-green-400',
  warn: 'text-yellow-400',
  error: 'text-red-400',
};

const StripThumb = memo(function StripThumb({
  frame,
  idx,
  tile,
  selected,
  rootRef,
  onEnter,
  onLeave,
  onPick,
  onRetry,
}: {
  frame: any;
  idx: number;
  tile?: TileState;
  selected: boolean;
  rootRef: React.RefObject<HTMLDivElement | null>;
  onEnter: (f: any) => void;
  onLeave: (key: string) => void;
  onPick: (f: any) => void;
  onRetry: (f: any) => void;
}) {
  const key = frameKey(frame);
  return (
    <LazyCell
      rootRef={rootRef}
      onEnter={() => onEnter(frame)}
      onLeave={() => onLeave(key)}
      onClick={() => onPick(frame)}
      className={`shrink-0 w-24 flex flex-col gap-1 p-1 rounded border cursor-pointer transition ${
        selected ? 'border-blue-500 bg-gray-800' : 'border-gray-800 bg-gray-900 hover:border-gray-600'
      }`}
    >
      <div className="flex-1 min-h-0 bg-black rounded overflow-hidden flex items-center justify-center">
        {tile?.status === 'ok' && tile.src && (
          <img src={tile.src} alt={`Frame ${idx + 1}`} draggable={false} decoding="async" className="w-full h-full object-cover" style={{ imageRendering: 'pixelated' }} />
        )}
        {tile?.status === 'loading' && <div className="h-4 w-4 rounded-full border-2 border-gray-700 border-t-blue-500 animate-spin" />}
        {!tile && <span className="text-[9px] text-gray-700">…</span>}
        {tile?.status === 'error' && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRetry(frame);
            }}
            className="text-[10px] text-red-400 hover:text-red-300"
          >
            ↻ error
          </button>
        )}
      </div>
      <div className="text-[9px] text-gray-400 font-mono truncate">
        #{idx + 1} · {frame.date || frame.energy_bandpassname || 'IR'}
      </div>
    </LazyCell>
  );
});

// These subscribe to frameStore themselves so SkyMap doesn't re-render on every incoming frame
function ProgressText({ fmt }: { fmt: (p: ReturnType<typeof progress>) => React.ReactNode }) {
  useFrameStore();
  return <>{fmt(progress())}</>;
}

function PrepCard() {
  useFrameStore();
  const p = progress();
  if (p.pending === 0) return null;
  return (
    <div className="absolute top-3 right-3 z-20 w-44 md:w-60 bg-gray-900/95 border border-gray-700 rounded p-2.5 flex flex-col gap-1.5">
      <span className="text-[11px] text-gray-200">Preparing the timeline… {p.done}/{p.total}</span>
      <Bar value={p.total ? p.done / p.total : 0} />
      <span className="text-[10px] text-gray-500">
        {p.finished >= 2 ? `${fmtEta((p.elapsedMs / p.finished) * p.pending)} left` : 'each frame takes 10–25 s'}
      </span>
    </div>
  );
}

let aladinPromise: Promise<any> | null = null;

function loadAladin(): Promise<any> {
  if (aladinPromise) return aladinPromise;

  const loadAsScript = () =>
    new Promise<any>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = ALADIN_SRC;
      s.async = true;
      s.onload = () => (window.A ? resolve(window.A) : reject(new Error('Script loaded, but window.A does not exist')));
      s.onerror = () => reject(new Error(`Could not download ${ALADIN_SRC}`));
      document.head.appendChild(s);
    });

  const load = (async () => {
    let A: any = window.A;

    if (!A) {
      // The npm build is an ES module: native import() outside the bundler, falling back to a classic <script>
      try {
        const dynImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;
        const mod = await dynImport(new URL(ALADIN_SRC, window.location.origin).href);
        A = mod?.default || mod?.A || window.A;
      } catch (e: any) {
        try {
          A = await loadAsScript();
        } catch (e2: any) {
          throw new Error(`import(): ${e?.message || e} | script: ${e2?.message || e2}`);
        }
      }
    }

    if (!A) throw new Error('File loaded, but it does not export Aladin (default or A)');
    if (A.init && typeof A.init.then === 'function') await A.init;
    return A;
  })();

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('20 s timeout loading Aladin Lite')), 20000)
  );

  aladinPromise = Promise.race([load, timeout]).catch((e) => {
    aladinPromise = null;
    throw e;
  });
  return aladinPromise;
}

function setSurvey(aladin: any, A: any, url: string, onError: (m: string) => void) {
  const hips = A.imageHiPS(url, { errorCallback: () => onError(`HiPS not found: ${url}`) });
  aladin.setBaseImageLayer(hips);
}

export default function SkyMap() {
  const [ra, setRa] = useState('269.452075');
  const [dec, setDec] = useState('4.693391');
  const [picked, setPicked] = useState<{ ra: number; dec: number; fov: number } | null>(null);
  const [drawMode, setDrawMode] = useState(false);
  const [drawing, setDrawing] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [searchNote, setSearchNote] = useState('');
  const [saved, setSaved] = useState<SavedPoint[]>([]);
  const [pickName, setPickName] = useState('');
  const [fov, setFov] = useState(0.24);
  const [band, setBand] = useState('color');
  const [mode, setMode] = useState<Mode>('map');
  const [mapState, setMapState] = useState<MapState>('loading');
  const [mapMsg, setMapMsg] = useState('Loading Aladin Lite...');

  const [center, setCenter] = useState<Center>({ ra: '269.452075', dec: '4.693391', fov: 0.24 });
  const [frames, setFrames] = useState<any[]>([]);
  const [tiles, setTiles] = useState<Record<string, TileState>>({});
  const [phase, setPhase] = useState<Phase>('idle');
  const [statusMsg, setStatusMsg] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 });
  const [log, setLog] = useState<LogEntry[]>([]);
  const [showLog, setShowLog] = useState(true);
  const searchSecs = useElapsed(phase === 'searching');

  const runRef = useRef(0);
  const centerRef = useRef<Center>(center);
  const bandRef = useRef(band);
  const queueRef = useRef<{ key: string; run: () => Promise<void> }[]>([]);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const tilesRef = useRef<Record<string, TileState>>({});
  const activeRef = useRef(0);
  const blobUrlsRef = useRef<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const userPickedRef = useRef(false);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ px: number; py: number; vx: number; vy: number } | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const logBufRef = useRef<LogEntry[]>([]);
  const aladinRef = useRef<any>(null);
  const aRef = useRef<any>(null);
  const overlayRef = useRef<any>(null);
  const pausedRef = useRef(false);
  const fovRef = useRef(fov);
  const drawRef = useRef<{ x0: number; y0: number } | null>(null);
  const mapBoxRef = useRef<HTMLDivElement | null>(null);
  const pickOverlayRef = useRef<any>(null);

  tilesRef.current = tiles;
  fovRef.current = fov;

  // Throttled: batches 300 ms of log lines into a single re-render
  const addLog = useCallback((level: LogLevel, text: string) => {
    const t = new Date().toLocaleTimeString('en-US');
    const first = logBufRef.current.length === 0;
    logBufRef.current.push({ t, level, text });
    if (first) {
      setTimeout(() => {
        const batch = logBufRef.current;
        logBufRef.current = [];
        setLog((prev) => [...prev, ...batch].slice(-300));
      }, 300);
    }
  }, []);

  useEffect(() => {
    const box = logEndRef.current?.parentElement;
    if (box) box.scrollTop = box.scrollHeight;
  }, [log, showLog]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SAVED_KEY);
      if (raw) setSaved(JSON.parse(raw));
    } catch {}
  }, []);

  const persistSaved = (list: SavedPoint[]) => {
    setSaved(list);
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(list));
    } catch {}
  };

  useEffect(() => {
    setPickName('');
  }, [picked?.ra, picked?.dec]);

  const moveMap = useCallback(
    (c: Center) => {
      const al = aladinRef.current;
      const A = aRef.current;
      if (!al || !A) return;
      try {
        const r = parseFloat(c.ra);
        const d = parseFloat(c.dec);
        al.gotoRaDec(r, d);
        const setF = al.setFoV || al.setFov;
        if (setF) setF.call(al, c.fov * MAP_FOV_FACTOR);

        // Yellow circle = area cropped from the frames
        if (!overlayRef.current) {
          overlayRef.current = A.graphicOverlay({ color: '#facc15', lineWidth: 2 });
          al.addOverlay(overlayRef.current);
        } else {
          overlayRef.current.removeAll();
        }
        overlayRef.current.add(A.circle(r, d, c.fov / 2));
      } catch (e: any) {
        addLog('warn', `Aladin (move map): ${e?.message || e}`);
      }
    },
    [addLog]
  );

  // Cyan circle = user-picked area (f = null clears it)
  const showPick = useCallback(
    (r: number, d: number, f: number | null) => {
      const al = aladinRef.current;
      const A = aRef.current;
      if (!al || !A) return;
      try {
        if (!pickOverlayRef.current) {
          pickOverlayRef.current = A.graphicOverlay({ color: '#22d3ee', lineWidth: 2 });
          al.addOverlay(pickOverlayRef.current);
        } else {
          pickOverlayRef.current.removeAll();
        }
        if (f !== null) pickOverlayRef.current.add(A.circle(r, d, f / 2));
      } catch (e: any) {
        addLog('warn', `Aladin (mark area): ${e?.message || e}`);
      }
    },
    [addLog]
  );

  const initAladin = useCallback(
    (isCancelled: () => boolean = () => false) => {
      setMapState('loading');
      setMapMsg('Loading Aladin Lite...');
      addLog('info', 'Loading Aladin Lite from CDS...');

      loadAladin()
        .then((A) => {
          if (isCancelled() || aladinRef.current) return;
          const c = centerRef.current;
          const bandUrl = surveyUrl(bandRef.current);
          aRef.current = A;
          aladinRef.current = A.aladin('#aladin-lite-div', {
            survey: bandUrl,
            target: `${c.ra} ${c.dec}`,
            fov: c.fov * MAP_FOV_FACTOR,
            projection: 'SIN',
            cooFrame: 'equatorial',
            showCooGrid: false,
            showFullscreenControl: false,
            showSimbadPointerControl: false,
          });

          moveMap(c);
          aladinRef.current.on('click', (e: any) => {
            if (e?.isDragging) return;
            if (!Number.isFinite(e?.ra) || !Number.isFinite(e?.dec)) return;
            addLog('info', `Map click: RA ${e.ra.toFixed(5)}, Dec ${e.dec.toFixed(5)}`);
            setPicked({ ra: e.ra, dec: e.dec, fov: fovRef.current });
            showPick(e.ra, e.dec, fovRef.current);
          });
          setMapState('ready');
          setMapMsg('Map ready');
          addLog('ok', `Aladin ready · HiPS ${bandRef.current}`);
        })
        .catch((e: any) => {
          if (isCancelled()) return;
          setMapState('error');
          setMapMsg(e?.message || 'Unknown error');
          addLog('error', `Aladin: ${e?.message || e}`);
        });
    },
    [addLog, moveMap, showPick]
  );

  useEffect(() => {
    let cancelled = false;
    initAladin(() => cancelled);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bandRef.current = band;
    const al = aladinRef.current;
    const A = aRef.current;
    if (!al || !A) return;
    try {
      setSurvey(al, A, surveyUrl(band), (m) => addLog('error', m));
      addLog('info', `Background switched to ${band}`);
    } catch (e: any) {
      addLog('error', `Failed to switch HiPS: ${e?.message || e}`);
    }
  }, [band, addLog]);

  const setTile = useCallback((key: string, state: TileState) => {
    setTiles((prev) => ({ ...prev, [key]: state }));
  }, []);

  const pump = useCallback(() => {
    while (!pausedRef.current && activeRef.current < MAX_PARALLEL && queueRef.current.length > 0) {
      const item = queueRef.current.shift()!;
      activeRef.current++;
      item.run().finally(() => {
        activeRef.current--;
        pump();
      });
    }
  }, []);

  const loadTile = useCallback(
    (key: string, url: string, runId: number) => {
      if (!url) {
        setTile(key, { status: 'error', message: 'No URL' });
        return;
      }
      setTile(key, { status: 'loading' });

      queueRef.current.push({
        key,
        run: async () => {
          if (runId !== runRef.current) return;
          const signal = abortRef.current?.signal;
          const t0 = Date.now();
          try {
            const res = await fetch(url, { signal });
            if (runId !== runRef.current) return;
            const secs = ((Date.now() - t0) / 1000).toFixed(1);

            if (res.status === 422) {
              setTile(key, { status: 'nocoverage' });
              addLog('info', `${shortName(key)}: no coverage (${secs}s)`);
              return;
            }
            if (res.status === 499) return;
            if (!res.ok) {
              let detail = `HTTP ${res.status}`;
              try {
                const j = await res.json();
                if (j?.error) detail += ` · ${j.error}`;
              } catch {}
              throw new Error(detail);
            }

            const blob = await res.blob();
            if (runId !== runRef.current) return;
            const src = URL.createObjectURL(blob);
            blobUrlsRef.current.push(src);
            setTile(key, { status: 'ok', src });
            addLog('ok', `${shortName(key)}: ok (${secs}s)`);
          } catch (err: any) {
            if (err?.name === 'AbortError' || runId !== runRef.current) return;
            const msg = err?.message || 'Unknown error';
            setTile(key, { status: 'error', message: msg });
            addLog('error', `${shortName(key)}: ${msg}`);
          }
        },
      });

      pump();
    },
    [pump, setTile, addLog]
  );

  const enterTile = useCallback(
    (frame: any) => {
      const key = frameKey(frame);
      if (tilesRef.current[key]) return;
      if (queueRef.current.some((q) => q.key === key)) return;
      loadTile(key, buildPngUrl(frame, centerRef.current), runRef.current);
    },
    [loadTile]
  );

  // Left the viewport before starting to download: drop it from the queue
  const cancelQueued = useCallback((key: string) => {
    const i = queueRef.current.findIndex((q) => q.key === key);
    if (i < 0) return;
    queueRef.current.splice(i, 1);
    setTiles((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const retryTile = useCallback(
    (frame: any) => {
      loadTile(frameKey(frame), buildPngUrl(frame, centerRef.current), runRef.current);
    },
    [loadTile]
  );

  // Selects the frame and moves it to the front of the queue
  const pickFrame = useCallback(
    (frame: any) => {
      const key = frameKey(frame);
      userPickedRef.current = true;
      setSelectedKey(key);
      setMode('frame');

      const st = tilesRef.current[key]?.status;
      if (st === 'ok' || st === 'nocoverage') return;
      if (!st || st === 'error') retryTile(frame);
      const i = queueRef.current.findIndex((q) => q.key === key);
      if (i > 0) queueRef.current.unshift(queueRef.current.splice(i, 1)[0]);
    },
    [retryTile]
  );

  const onSelectFrame = useCallback((k: string) => {
    userPickedRef.current = true;
    setSelectedKey(k);
  }, []);

  const fetchData = async (targetRa: string, targetDec: string, targetFov: number) => {
    const runId = ++runRef.current;

    abortRef.current?.abort();
    abortRef.current = new AbortController();
    queueRef.current = [];
    blobUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    blobUrlsRef.current = [];
    userPickedRef.current = false;

    const cleanRa = parseFloat(targetRa);
    const cleanDec = parseFloat(targetDec);
    if (isNaN(cleanRa) || isNaN(cleanDec)) {
      setPhase('error');
      setStatusMsg('Invalid RA and Dec coordinates. Use decimal degrees, e.g. 269.452075.');
      addLog('error', 'Invalid coordinates');
      return;
    }

    const c: Center = { ra: String(cleanRa), dec: String(cleanDec), fov: targetFov };
    centerRef.current = c;
    setCenter(c);
    moveMap(c);
    showPick(0, 0, null);
    setSearchNote('');

    setFrames([]);
    setTiles({});
    setSelectedKey(null);
    setView({ s: 1, x: 0, y: 0 });
    setMode('map');
    setPicked(null);
    setPhase('searching');
    setStatusMsg('Querying IRSA (can take up to 30 s if it is slow)...');
    addLog('info', `Search: RA ${c.ra}, Dec ${c.dec}, field ${c.fov}°`);

    const t0 = Date.now();
    try {
      const res = await fetch(`/api/spherex?ra=${c.ra}&dec=${c.dec}&size=${SEARCH_RADIUS}`, {
        signal: abortRef.current.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (runId !== runRef.current) return;

      const dbg = data?.debug;
      setSearchNote(noteFrom(dbg));
      if (dbg) {
        addLog('info', `Server: ${dbg.source}${dbg.stale ? ' (STALE DATA)' : ''} in ${dbg.elapsedMs}ms`);
        (dbg.attempts || []).forEach((a: any) =>
          addLog(
            a.status === 200 ? 'ok' : 'warn',
            `  ${a.via || ''} attempt ${a.n}: ${a.status} in ${a.ms}ms${a.note ? ' · ' + a.note : ''}`
          )
        );
      }

      if (!res.ok) {
        throw new Error(
          `${data?.error || 'Search failed'} (HTTP ${res.status}${dbg?.error ? ' · ' + dbg.error : ''})`
        );
      }

      const items = (data.data || []).filter((f: any) => frameKey(f));
      setFrames(items);
      addLog(items.length ? 'ok' : 'warn', `${items.length} observations in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

      if (items.length === 0) {
        setPhase('done');
        setStatusMsg('No SPHEREx observation covers these coordinates.');
        return;
      }

      setPhase('done');
setStatusMsg(`${items.length} observations found.`);
    } catch (err: any) {
      if (err?.name === 'AbortError' || runId !== runRef.current) return;
      console.error(err);
      setPhase('error');
      setStatusMsg(err?.message || 'Error fetching data.');
      addLog('error', err?.message || 'Error fetching data');
    }
  };

  useEffect(() => {
    fetchData(ra, dec, fov);
    return () => {
      abortRef.current?.abort();
      blobUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-selects the first frame with coverage until the user picks one
  useEffect(() => {
    if (userPickedRef.current) return;
    const first = frames.find((f) => tiles[frameKey(f)]?.status === 'ok');
    if (first) setSelectedKey(frameKey(first));
  }, [tiles, frames]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const p = parseCoords(`${ra} ${dec}`);
    if (!p) {
      setPhase('error');
      setStatusMsg('Could not parse the coordinates. Examples: "269.452 4.693" or "08h55m10.8s -07d14m42s". You can paste both into the RA field.');
      return;
    }
    const r = String(p.ra);
    const d = String(p.dec);
    setRa(r);
    setDec(d);
    fetchData(r, d, fov);
  };

  const selectTarget = (t: { ra: string; dec: string }) => {
    setRa(t.ra);
    setDec(t.dec);
    fetchData(t.ra, t.dec, fov);
  };

  const savePoint = (name: string, r: string, d: string, f: number) => {
    const same = saved.find(
      (p) =>
        Math.abs(parseFloat(p.ra) - parseFloat(r)) < 1e-5 &&
        Math.abs(parseFloat(p.dec) - parseFloat(d)) < 1e-5 &&
        p.fov === f
    );
    if (same) {
      addLog('info', `This point is already saved as "${same.name}"`);
      return;
    }
    const p: SavedPoint = {
      id: Date.now().toString(36),
      name: name.trim() || `Point ${saved.length + 1}`,
      ra: r,
      dec: d,
      fov: f,
    };
    persistSaved([...saved, p]);
    addLog('ok', `Point saved: ${p.name} (RA ${p.ra}, Dec ${p.dec}, field ${p.fov}°)`);
  };

  const selectPoint = (p: SavedPoint) => {
    setRa(p.ra);
    setDec(p.dec);
    setFov(p.fov);
    fetchData(p.ra, p.dec, p.fov);
  };

  const removePoint = (id: string) => {
    persistSaved(saved.filter((p) => p.id !== id));
  };

  const retryAllErrors = () => {
    frames.forEach((f) => {
      if (tiles[frameKey(f)]?.status === 'error') retryTile(f);
    });
  };

  // Draw an area: click the center and drag to the edge
  const pixToSky = (x: number, y: number): [number, number] | null => {
    try {
      const r = aladinRef.current?.pix2world(x, y);
      if (r && Number.isFinite(r[0]) && Number.isFinite(r[1])) return [r[0], r[1]];
    } catch {}
    return null;
  };
  const relPos = (e: React.PointerEvent) => {
    const r = mapBoxRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const onDrawDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = relPos(e);
    drawRef.current = { x0: p.x, y0: p.y };
    setDrawing({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };
  const onDrawMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drawRef.current;
    if (!d) return;
    const p = relPos(e);
    setDrawing({ x0: d.x0, y0: d.y0, x1: p.x, y1: p.y });
  };
  const onDrawUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drawRef.current;
    drawRef.current = null;
    setDrawing(null);
    if (!d) return;
    const p = relPos(e);
    const c = pixToSky(d.x0, d.y0);
    if (!c) {
      addLog('warn', 'Could not convert the screen point to coordinates (pix2world).');
      return;
    }
    let f = fov; // click without dragging: use the current field
    if (Math.hypot(p.x - d.x0, p.y - d.y0) >= 8) {
      const edge = pixToSky(p.x, p.y);
      if (edge) f = Math.min(FOV_MAX, Math.max(FOV_MIN, Math.round(2 * sepDeg(c[0], c[1], edge[0], edge[1]) * 1000) / 1000));
    }
    addLog('info', `Area drawn: RA ${c[0].toFixed(5)}, Dec ${c[1].toFixed(5)}, field ${f}°`);
    setPicked({ ra: c[0], dec: c[1], fov: f });
    showPick(c[0], c[1], f);
    setDrawMode(false);
  };
  useEffect(() => {
    if (!drawMode) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        drawRef.current = null;
        setDrawing(null);
        setDrawMode(false);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [drawMode]);

  const zoomAt = (factor: number, cx: number, cy: number) => {
    setView((v) => {
      const s = Math.min(16, Math.max(1, v.s * factor));
      const k = s / v.s;
      return { s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  };
  const onWheel = (e: React.WheelEvent) => {
    const rect = viewerRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - rect.left, e.clientY - rect.top);
  };
  const zoomButton = (factor: number) => {
    const rect = viewerRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(factor, rect.width / 2, rect.height / 2);
  };
  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.vx + (e.clientX - d.px), y: d.vy + (e.clientY - d.py) }));
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const requested = frames.filter((f) => tiles[frameKey(f)]);
  const counts = { loading: 0, ok: 0, nocoverage: 0, error: 0 };
  requested.forEach((f) => {
    counts[tiles[frameKey(f)].status]++;
  });
  const done = counts.ok + counts.nocoverage + counts.error;
  const allDone = requested.length > 0 && done === requested.length;

  let banner: { color: string; text: string };
  const blue = 'bg-blue-900/40 border-blue-700 text-blue-200';
  if (phase === 'searching') banner = { color: blue, text: '⏳ ' + statusMsg };
  else if (phase === 'error') banner = { color: 'bg-red-900/40 border-red-700 text-red-200', text: '❌ ' + statusMsg };
  else if (frames.length === 0) banner = { color: 'bg-gray-800 border-gray-700 text-gray-300', text: statusMsg || 'Ready.' };
  else if (requested.length === 0)
    banner = { color: blue, text: `${frames.length} observations found. Open "Timeline" to see how this patch of sky changes.` };
  else if (!allDone)
    banner = { color: blue, text: `⏳ Downloading visible cutouts: ${done}/${requested.length} (of ${frames.length})` };
  else if (counts.ok === 0)
    banner = { color: 'bg-red-900/40 border-red-700 text-red-200', text: '❌ No cutout worked. See the log.' };
  else if (counts.error > 0)
    banner = { color: 'bg-yellow-900/40 border-yellow-700 text-yellow-200', text: `⚠️ ${counts.ok} ok, but ${counts.error} failed.` };
  else
    banner = { color: 'bg-green-900/40 border-green-700 text-green-200', text: `✅ ${counts.ok} of ${frames.length} cutouts loaded (${counts.nocoverage} without coverage). Scroll the strip for more.` };
  const loading = phase === 'searching';
  const selectedFrame = frames.find((f) => frameKey(f) === selectedKey) || null;
  const selectedTile = selectedKey ? tiles[selectedKey] : undefined;
  const stripFrames = frames
    .map((frame, idx) => ({ frame, idx }))
    .filter(({ frame }) => tiles[frameKey(frame)]?.status !== 'nocoverage');

  const mapChip =
    mapState === 'ready'
      ? 'bg-green-900/40 border-green-700 text-green-300'
      : mapState === 'error'
      ? 'bg-red-900/40 border-red-700 text-red-300'
      : 'bg-blue-900/40 border-blue-700 text-blue-300';

  return (
    <div className="flex flex-col min-h-screen supports-[height:1dvh]:min-h-[100dvh] bg-gray-950 text-white">
      <FeedbackStyles />
      <header className="flex flex-col md:flex-row md:flex-wrap md:items-center md:justify-between gap-2 md:gap-4 p-2 md:p-3 bg-gray-900 border-b border-gray-800 shadow-md">
        <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3 min-w-0">
          <h1 className="text-base font-bold text-blue-400">SPHEREx Sky Explorer</h1>
          <div className="flex items-center gap-1 overflow-x-auto md:overflow-visible md:flex-wrap -mx-2 px-2 md:mx-0 md:px-0 pb-1 md:pb-0">
            {CHALLENGE_TARGETS.map((t) => (
              <button
                key={t.name}
                onClick={() => selectTarget(t)}
                className="shrink-0 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 px-2.5 py-1.5 md:py-1 rounded transition"
              >
                {t.name}
              </button>
            ))}

            {saved.length > 0 && <span className="shrink-0 w-px h-5 bg-gray-700 mx-1" />}
            {saved.map((p) => (
              <div key={p.id} className="shrink-0 flex items-center rounded border border-cyan-800 bg-cyan-950/40 text-xs">
                <button
                  onClick={() => selectPoint(p)}
                  title={`RA ${p.ra} · Dec ${p.dec} · field ${p.fov}°`}
                  className="px-2.5 py-1.5 md:py-1 hover:bg-cyan-900/50 rounded-l max-w-[10rem] truncate"
                >
                  ⭐ {p.name}
                </button>
                <button
                  onClick={() => removePoint(p.id)}
                  title="Delete this point"
                  className="px-2 py-1.5 md:py-1 text-gray-400 hover:text-red-400 hover:bg-cyan-900/50 rounded-r"
                >
                  ×
                </button>
              </div>
            ))}

            <a href="https://gioperovano.github.io/astrobyte2/ar/" className="shrink-0">
              <button className="ml-2 md:ml-5 text-xs md:text-base font-bold transition-all bg-amber-600 px-3 py-1.5 md:p-2 rounded-2xl hover:cursor-pointer hover:bg-amber-400 hover:text-black">
                AstroByte
              </button>
            </a>

            <a href="https://gioperovano.github.io/astrobyte2/game" className="shrink-0">
              <button className="ml-2 md:ml-5 text-xs md:text-base font-bold transition-all bg-amber-600 px-3 py-1.5 md:p-2 rounded-2xl hover:cursor-pointer hover:bg-amber-400 hover:text-black">
                Game
              </button>
            </a>
          </div>
        </div>

        <form onSubmit={handleSearch} className="flex flex-wrap gap-2 items-center text-sm">
          <div className="flex flex-1 md:flex-none items-center gap-1 bg-gray-800 border border-gray-700 px-2 py-1 rounded min-w-[7.5rem]">
            <span className="text-[10px] text-gray-400">RA:</span>
            <input
              type="text"
              inputMode="text"
              value={ra}
              onChange={(e) => setRa(e.target.value)}
              className="w-full md:w-20 min-w-0 bg-transparent text-white text-base md:text-xs outline-none"
            />
          </div>
          <div className="flex flex-1 md:flex-none items-center gap-1 bg-gray-800 border border-gray-700 px-2 py-1 rounded min-w-[7.5rem]">
            <span className="text-[10px] text-gray-400">Dec:</span>
            <input
              type="text"
              inputMode="text"
              value={dec}
              onChange={(e) => setDec(e.target.value)}
              className="w-full md:w-20 min-w-0 bg-transparent text-white text-base md:text-xs outline-none"
            />
          </div>
          <div className="flex flex-1 md:flex-none items-center gap-1 bg-gray-800 border border-gray-700 px-2 py-1 rounded min-w-[7.5rem]">
            <span className="text-[10px] text-gray-400">Field:</span>
            <select
              value={fov}
              onChange={(e) => setFov(parseFloat(e.target.value))}
              className="w-full bg-transparent text-white text-base md:text-xs outline-none"
            >
              {(FOV_OPTIONS.includes(fov) ? FOV_OPTIONS : [...FOV_OPTIONS, fov].sort((a, b) => a - b)).map((o) => (
                <option key={o} value={o} className="bg-gray-900">
                  {o}°{FOV_OPTIONS.includes(o) ? '' : ' (drawn)'}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full md:w-auto bg-blue-600 hover:bg-blue-500 disabled:opacity-60 px-4 py-2 md:py-1 rounded text-xs font-medium transition"
          >
            {loading ? 'Searching...' : 'Generate Map'}
          </button>
        </form>
      </header>

<div className="flex flex-col md:flex-row flex-1 relative">
          <main className="flex-1 flex flex-col min-w-0 p-2 md:p-4 gap-3">
          <div className={`border rounded px-3 py-2 text-xs flex flex-wrap items-center justify-between gap-2 ${banner.color}`}>
            <span>{banner.text}</span>
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
              <span>RA {center.ra}, Dec {center.dec} · {center.fov}°</span>
              {phase !== 'searching' && (
                <button
                  onClick={() => savePoint('', center.ra, center.dec, center.fov)}
                  title="Saves the current target (coordinates and field) to My points"
                  className="bg-cyan-700 hover:bg-cyan-600 px-3 py-1 md:py-0.5 rounded-full text-white font-sans transition"
                >
                  ⭐ Save target
                </button>
              )}
              {counts.error > 0 && (
                <button onClick={retryAllErrors} className="bg-blue-600 hover:bg-blue-500 px-3 py-1 md:py-0.5 rounded-full text-white font-sans transition">
                  Retry errors
                </button>
              )}
              {phase === 'error' && (
                <button onClick={() => fetchData(ra, dec, fov)} className="bg-blue-600 hover:bg-blue-500 px-3 py-1 md:py-0.5 rounded-full text-white font-sans transition">
                  Retry
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div className="flex rounded overflow-hidden border border-gray-700">
              <button
                onClick={() => setMode('map')}
                className={`px-3 py-2 md:py-1 transition ${mode === 'map' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
              >
                🗺️ Sky map
              </button>

              <button
                onClick={() => setMode('video')}
                className={`px-3 py-2 md:py-1 transition disabled:opacity-40 ${mode === 'video' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
              >
                🎬 Timeline
                <ProgressText
                  fmt={(p) => (
                    <>
                      {p.total > 0 ? ` · ${p.done}/${p.total}` : ''}
                      {p.pending > 0 && (
                        <span className="ml-1.5 inline-block h-2.5 w-2.5 rounded-full border-2 border-white/40 border-t-white animate-spin align-middle" />
                      )}
                    </>
                  )}
                />
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-1 bg-gray-800 border border-gray-700 px-2 py-1 rounded">
              <span className="text-[10px] text-gray-400">Map background:</span>
              <button
                onClick={() => { setMode('map'); setDrawMode((d) => !d); }}
                disabled={mapState !== 'ready'}
                className={`px-3 py-1.5 md:py-1 rounded border text-xs transition disabled:opacity-40 ${
                  drawMode ? 'bg-cyan-600 border-cyan-400 text-white' : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700'
                }`}
                title="Click the center of the area and drag to its edge"
              >
                ⭕ Draw area
              </button>
              <select value={band} onChange={(e) => setBand(e.target.value)} className="bg-transparent text-white text-xs outline-none">
                {SURVEYS.map((b) => (
                  <option key={b.id} value={b.id} className="bg-gray-900">
                    {b.label}
                  </option>
                ))}
              </select>
            </div>

            <span className={`border rounded-full px-2.5 py-0.5 text-[11px] ${mapChip}`}>
              {mapState === 'ready' ? '🟢' : mapState === 'error' ? '🔴' : '🟡'} Aladin: {mapMsg}
            </span>
            {mapState === 'error' && (
              <button onClick={() => initAladin()} className="bg-blue-600 hover:bg-blue-500 px-3 py-1 md:py-0.5 rounded-full text-white transition">
                Retry Aladin
              </button>
            )}
          </div>

          {requested.length > 0 && !allDone && (
            <div className="h-1.5 w-full bg-gray-800 rounded overflow-hidden">
              <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${(done / requested.length) * 100}%` }} />
            </div>
          )}

          {/* Map, frame and timeline stay mounted; only visibility toggles */}
<div className={`${mode === 'video' ? 'max-md:h-[90vh] max-md:supports-[height:1dvh]:h-[90dvh]' : 'max-md:h-[65vh] max-md:supports-[height:1dvh]:h-[65dvh]'} min-h-[22rem] md:min-h-[18rem] md:flex-1 relative bg-black rounded-lg border border-gray-800 overflow-hidden`}>            <div className={`absolute inset-0 ${mode === 'map' ? '' : 'invisible pointer-events-none'}`}>
              <div ref={mapBoxRef} className="absolute inset-0">
                <div id="aladin-lite-div" style={{ width: '100%', height: '100%' }} />
              </div>
              {drawMode && (
                <div
                  className="absolute inset-0 z-20 cursor-crosshair touch-none select-none"
                  onPointerDown={onDrawDown}
                  onPointerMove={onDrawMove}
                  onPointerUp={onDrawUp}
                  onPointerCancel={() => { drawRef.current = null; setDrawing(null); }}
                >
                  <div className="absolute top-3 left-1/2 -translate-x-1/2 w-max max-w-[92%] text-center bg-gray-900/90 border border-cyan-700 text-cyan-200 text-xs px-3 py-1.5 rounded-full pointer-events-none">
                    Tap the center and drag to the edge <span className="hidden md:inline">· Esc cancels</span>
                  </div>
                  {drawing && (
                    <svg className="absolute inset-0 w-full h-full pointer-events-none">
                      <circle
                        cx={drawing.x0}
                        cy={drawing.y0}
                        r={Math.hypot(drawing.x1 - drawing.x0, drawing.y1 - drawing.y0)}
                        fill="rgba(34,211,238,0.12)"
                        stroke="#22d3ee"
                        strokeWidth={2}
                        strokeDasharray="6 4"
                      />
                      <line x1={drawing.x0} y1={drawing.y0} x2={drawing.x1} y2={drawing.y1} stroke="#22d3ee" strokeWidth={1} />
                    </svg>
                  )}
                  <button
                    onPointerDown={(e) => e.stopPropagation()}
                    onPointerUp={(e) => e.stopPropagation()}
                    onClick={() => { drawRef.current = null; setDrawing(null); setDrawMode(false); }}
                    className="md:hidden absolute bottom-3 left-3 bg-gray-900/90 border border-gray-600 text-gray-200 text-xs px-3 py-1.5 rounded-full"
                  >
                    Cancel
                  </button>
                </div>
              )}
              {mapState !== 'ready' && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-center px-6 z-10">
                  {mapState === 'loading' ? (
                    <div className="flex flex-col items-center gap-2 text-gray-400">
                      <div className="h-8 w-8 rounded-full border-2 border-gray-700 border-t-blue-500 animate-spin" />
                      <span className="text-xs">{mapMsg}</span>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-2 max-w-md">
                      <span className="text-sm text-red-400">Could not load the map</span>
                      <span className="text-xs text-gray-400">{mapMsg}</span>
                      <span className="text-[11px] text-gray-500">
                        Individual frames still work in the “Single frame” tab.
                      </span>
                    </div>
                  )}
                </div>
              )}

              {picked && (
                <div className="absolute top-3 left-3 z-10 w-72 max-w-[calc(100%-1.5rem)] bg-gray-900/95 border border-cyan-800 rounded p-3 text-xs flex flex-col gap-2">
                  <span className="font-mono text-gray-200">RA {picked.ra.toFixed(5)} · Dec {picked.dec.toFixed(5)}</span>
                  <span className="text-gray-400">Radius {((picked.fov / 2) * 60).toFixed(1)}′ · {picked.fov}° cutout</span>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => {
                        const r = picked.ra.toFixed(6);
                        const d = picked.dec.toFixed(6);
                        setRa(r);
                        setDec(d);
                        setFov(picked.fov);
                        fetchData(r, d, picked.fov);
                      }}
                      className="bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 md:py-1 rounded"
                    >
                      Generate timeline here
                    </button>
                    <button
                      onClick={() => { setPicked(null); showPick(0, 0, null); }}
                      className="bg-gray-800 hover:bg-gray-700 px-3 py-1.5 md:py-1 rounded"
                    >
                      cancel
                    </button>
                  </div>
                  <div className="flex gap-2 border-t border-gray-800 pt-2">
                    <input
                      type="text"
                      value={pickName}
                      onChange={(e) => setPickName(e.target.value)}
                      placeholder="Point name (optional)"
                      maxLength={40}
                      className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 md:py-1 text-base md:text-xs text-white outline-none"
                    />
                    <button
                      onClick={() => {
                        savePoint(pickName, picked.ra.toFixed(6), picked.dec.toFixed(6), picked.fov);
                        setPickName('');
                      }}
                      className="shrink-0 bg-cyan-700 hover:bg-cyan-600 text-white px-3 py-1.5 md:py-1 rounded"
                    >
                      ⭐ Save
                    </button>
                  </div>
                </div>
              )}

              {frames.length > 0 && (
                <button
                  onClick={() => setMode('video')}
                  className="absolute bottom-3 right-3 z-10 max-w-[calc(100%-1.5rem)] bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium px-4 py-2 rounded-full shadow"
                >
                  <span className="md:hidden">▶ Timeline</span>
                  <span className="hidden md:inline">▶ See how this patch of sky changes over time</span>
                  <ProgressText fmt={(p) => (p.total > 0 ? ` (${p.done}/${p.total} ready)` : '')} />
                </button>
              )}
              {mapState === 'ready' && (
                <div className="hidden md:block absolute top-3 right-3 max-w-xs text-right text-[10px] text-gray-300 font-mono pointer-events-none z-10 drop-shadow bg-gray-950/70 rounded px-2 py-1">
                  Background: CDS HiPS · yellow circle = frame cutout area
                </div>
              )}
            </div>

            <div className={`absolute inset-0 ${mode === 'frame' ? '' : 'invisible pointer-events-none'}`}>
              <div
                ref={viewerRef}
                className="absolute inset-0 cursor-grab active:cursor-grabbing touch-none select-none"
                onWheel={onWheel}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                {selectedTile?.status === 'ok' && selectedTile.src ? (
                  <div
                    className="absolute inset-0"
                    style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, transformOrigin: '0 0' }}
                  >
                    <img src={selectedTile.src} alt="SPHEREx frame" draggable={false} className="w-full h-full object-contain" style={{ imageRendering: 'pixelated' }} />
                    <div
                      className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-yellow-400/80 pointer-events-none"
                      style={{ width: `${28 / view.s}px`, height: `${28 / view.s}px`, borderWidth: `${1 / view.s}px` }}
                    />
                  </div>
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm px-6 text-center">
                    {selectedTile?.status === 'error' ? (
                      <div className="flex flex-col items-center gap-2">
                        <span className="text-xs text-red-400">{selectedTile.message}</span>
                        {selectedFrame && (
                          <button onClick={() => retryTile(selectedFrame)} className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-600 px-3 py-1 rounded">
                            ↻ Retry
                          </button>
                        )}
                      </div>
                    ) : phase === 'searching' || (phase === 'rendering' && !allDone) ? (
                      <div className="flex flex-col items-center gap-2">
                        <div className="h-8 w-8 rounded-full border-2 border-gray-700 border-t-blue-500 animate-spin" />
                        <span className="text-xs">Building the frame...</span>
                      </div>
                    ) : (
                      <span className="text-xs">No frame to show. See the log below.</span>
                    )}
                  </div>
                )}
              </div>

              <div className="absolute top-3 right-3 flex flex-col gap-1">
                <button onClick={() => zoomButton(1.5)} className="w-10 h-10 md:w-8 md:h-8 bg-gray-900/90 hover:bg-gray-800 border border-gray-700 rounded text-lg leading-none">+</button>
                <button onClick={() => zoomButton(1 / 1.5)} className="w-10 h-10 md:w-8 md:h-8 bg-gray-900/90 hover:bg-gray-800 border border-gray-700 rounded text-lg leading-none">−</button>
                <button onClick={() => setView({ s: 1, x: 0, y: 0 })} className="w-10 h-10 md:w-8 md:h-8 bg-gray-900/90 hover:bg-gray-800 border border-gray-700 rounded text-[10px]">1:1</button>
              </div>
              <div className="absolute bottom-2 left-3 right-3 text-[10px] text-gray-500 font-mono pointer-events-none">
                zoom {view.s.toFixed(1)}x
                <span className="hidden md:inline"> · mouse wheel = zoom · drag = pan · circle = target</span>
                <span className="md:hidden"> · + / − buttons · drag = pan</span>
              </div>
            </div>

            <div className={`absolute inset-0 ${mode === 'video' ? '' : 'invisible pointer-events-none'}`}>
              <TimelinePlayer
                frames={frames}
                center={center}
                active={frames.length > 0}
                visible={mode === 'video'}
                searching={phase === 'searching'}
                emptyMessage={
                  phase === 'error'
                    ? statusMsg
                    : `No observations found for these coordinates.${searchNote ? ' ' + searchNote : ''}`
                }
                selectedKey={selectedKey}
                onSelect={onSelectFrame}
              />
            </div>
            {phase === 'searching' && (
              <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black/50 text-center px-6 pointer-events-none">
                <Radar size={72} />
                <span className="text-sm text-gray-200">Searching for SPHEREx observations at this point…</span>
                <span className="text-[11px] text-gray-400 font-mono">{searchSecs}s · querying IRSA (up to 30 s if slow)</span>
              </div>
            )}
            {mode !== 'video' && frames.length > 0 && <PrepCard />}
          </div>

          {/* Each thumbnail only downloads when it nears the visible area */}
<div ref={stripRef} className="h-28 [@media(max-height:700px)]:h-20 shrink-0 overflow-x-auto overflow-y-hidden">            <div className="flex gap-2 h-full">
              {stripFrames.map(({ frame, idx }) => {
                const key = frameKey(frame);
                return (
                  <StripThumb
                    key={key}
                    frame={frame}
                    idx={idx}
                    tile={tiles[key]}
                    selected={selectedKey === key && mode === 'frame'}
                    rootRef={stripRef}
                    onEnter={enterTile}
                    onLeave={cancelQueued}
                    onPick={pickFrame}
                    onRetry={retryTile}
                  />
                );
              })}
            </div>
          </div>
        </main>

<aside className="relative w-full md:w-80 md:shrink-0 bg-gray-900/95 border-t md:border-t-0 md:border-l border-gray-800 z-10 backdrop-blur">
  <div className="flex flex-col gap-3 p-3 md:p-4 md:absolute md:inset-0 md:overflow-y-auto">          <div>
            <h3 className="font-semibold text-sm text-gray-200">Selected frame</h3>
            <p className="text-xs text-gray-400 mt-0.5">Tap a frame in the strip to see its cutout.</p>
          </div>

          {selectedFrame ? (
            <div className="bg-gray-800 p-3 rounded-lg border border-gray-700 flex flex-col gap-2">
              <div className="flex flex-col gap-1 text-xs">
                <div className="flex justify-between py-1 border-b border-gray-700">
                  <span className="text-gray-400">Frame:</span>
                  <span className="font-mono text-gray-200">#{frames.indexOf(selectedFrame) + 1} of {frames.length}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-gray-700">
                  <span className="text-gray-400">Date:</span>
                  <span className="font-mono text-gray-200">{selectedFrame.date || selectedFrame.obs_release_date || 'N/A'}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-gray-700">
                  <span className="text-gray-400">Band:</span>
                  <span className="font-mono text-gray-200">{selectedFrame.energy_bandpassname || 'N/A'}</span>
                </div>
              </div>
              <a
                href={selectedFrame.access_url}
                target="_blank"
                rel="noreferrer"
                className="text-center bg-blue-600 hover:bg-blue-500 text-white py-2 rounded text-xs font-medium transition block shadow"
              >
                📥 Download raw original FITS
              </a>
            </div>
          ) : (
            <div className="text-xs text-gray-500 py-4 text-center">No frame selected.</div>
          )}

<div className="md:flex-1 md:min-h-[10rem] flex flex-col border-t border-gray-800 pt-3">            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold text-xs text-gray-300">Debug log</h3>
              <div className="flex gap-3 text-[10px]">
                <button onClick={() => setShowLog((s) => !s)} className="text-gray-400 hover:text-white">{showLog ? 'hide' : 'show'}</button>
                <button onClick={() => setLog([])} className="text-gray-400 hover:text-white">clear</button>
              </div>
            </div>
            {showLog && (
<div className="h-48 md:h-auto md:flex-1 md:min-h-[6rem] overflow-y-auto bg-black/60 border border-gray-800 rounded p-2 font-mono text-[10px] leading-relaxed">                {log.length === 0 && <span className="text-gray-600">No events yet.</span>}
                {log.map((l, i) => (
                  <div key={i} className={LOG_COLORS[l.level]}>
                    <span className="text-gray-600">{l.t}</span> {l.text}
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            )}
          </div>

          <div className="text-[10px] text-center text-gray-500 border-t border-gray-800 pt-3">
            SPHEREx: IRSA/IPAC · Map background: CDS Strasbourg
          </div>
          </div>
        </aside>
      </div>
    </div>
  );
}