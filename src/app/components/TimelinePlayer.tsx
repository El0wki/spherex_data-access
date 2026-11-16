'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { keyOf, detOf, timeOf, mjdToDate, sortByTime, summarize, renderImage } from '../../lib/timeline';
import { setTarget, want, retryErrors, getSlot, progress, useFrameStore, type Loaded } from '../../lib/frameStore';
import { Radar, Bar, Skeleton, Steps, useElapsed, fmtEta } from './Feedback';

type Center = { ra: string; dec: string; fov: number };
type ViewMode = 'normal' | 'medsub' | 'mean';
type Crop = { n: number; x: number; y: number; w: number; h: number };
type Status = 'ok' | 'low' | 'pending' | 'loading' | 'err' | 'nocov';

const EXPORT_MIN_SIDE = 720; // longest side of the exported video, in pixels

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Largest rectangle where every pixel has cnt >= min (histogram algorithm, O(n²))
function largestRect(cnt: Uint16Array, n: number, min: number) {
  const h = new Int32Array(n + 1);
  let best = { x: 0, y: 0, w: 0, h: 0, area: 0 };
  const st: number[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) h[x] = cnt[y * n + x] >= min ? h[x] + 1 : 0;
    h[n] = 0;
    st.length = 0;
    for (let x = 0; x <= n; x++) {
      while (st.length && h[st[st.length - 1]] >= h[x]) {
        const height = h[st.pop() as number];
        const left = st.length ? st[st.length - 1] + 1 : 0;
        const width = x - left;
        const area = height * width;
        if (area > best.area) best = { x: left, y: y - height + 1, w: width, h: height, area };
      }
      st.push(x);
    }
  }
  return best;
}

function saveBlob(b: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const TICK_COLOR: Record<Status, string> = {
  ok: 'bg-blue-400',
  low: 'bg-amber-600',
  pending: 'bg-gray-600',
  loading: 'bg-blue-300 animate-pulse',
  err: 'bg-red-500',
  nocov: 'bg-gray-800',
};

function Thumb({ loaded, gain }: { loaded: Loaded; gain: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;

    const img = renderImage(loaded.data, loaded.n, loaded.n, gain);
    if (!img) return;

    cv.width = loaded.n;
    cv.height = loaded.n;

    const ctx = cv.getContext('2d');
    if (!ctx) return;

    ctx.putImageData(img, 0, 0);
  }, [loaded, gain]);

  return (
    <canvas
      ref={ref}
      className="w-full h-full object-contain block"
      style={{ imageRendering: 'pixelated' }}
    />
  );
}

const Tick = memo(function Tick({
  f,
  left,
  isCur,
  status,
  onPick,
}: {
  f: any;
  left: number;
  isCur: boolean;
  status: Status;
  onPick: (f: any) => void;
}) {
  return (
    <button
      onClick={() => onPick(f)}
      title={`${f.date || 'no date'} · ${status}`}
      className={`absolute -translate-x-1/2 rounded-sm ${
        isCur
          ? 'bg-white top-0 h-8 w-[4px] md:w-[3px] z-10'
          : `${TICK_COLOR[status]} top-0.5 h-7 w-[7px] md:w-[5px]`
      }`}
      style={{ left: `${left * 100}%` }}
    />
  );
});

const StripItem = memo(function StripItem({
  f,
  i,
  isCur,
  status,
  loaded,
  gain,
  onPick,
}: {
  f: any;
  i: number;
  isCur: boolean;
  status: Status;
  loaded?: Loaded;
  gain: number;
  onPick: (f: any) => void;
}) {
  return (
    <div
      data-i={i}
      onClick={() => onPick(f)}
      className={`shrink-0 w-16 md:w-20 flex flex-col gap-0.5 p-0.5 rounded border ${
        isCur ? 'border-blue-500 bg-gray-800' : 'border-gray-800 bg-gray-900'
      } ${status === 'ok' ? 'cursor-pointer hover:border-gray-600' : 'opacity-80'}`}
    >
      <div className="h-14 md:h-20 bg-black rounded overflow-hidden flex items-center justify-center p-0.5">
        {loaded ? (
          <div className="sx-fade w-full h-full">
            <Thumb loaded={loaded} gain={gain} />
          </div>
        ) : status === 'err' ? (
          <span className="text-[9px] text-red-400">error</span>
        ) : status === 'nocov' ? (
          <span className="text-[9px] text-gray-600">no cov.</span>
        ) : (
          <div className="relative w-full h-full">
            <Skeleton className="absolute inset-0" />
            {status === 'loading' && (
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-4 w-4 rounded-full border-2 border-gray-600 border-t-blue-400 animate-spin" />
            )}
          </div>
        )}
      </div>
      <div className="text-[9px] text-gray-400 font-mono truncate">{f.date || `#${i + 1}`}</div>
    </div>
  );
});

function TimelinePlayer({
  frames,
  center,
  active,
  visible = true,
  searching = false,
  emptyMessage,
  selectedKey,
  onSelect,
}: {
  frames: any[];
  center: Center;
  active: boolean; // download frames (can be true while the tab is hidden: preloads)
  visible?: boolean;
  searching?: boolean;
  emptyMessage?: string;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const version = useFrameStore();
  const pr = progress();
  const searchSecs = useElapsed(searching);

  const [det, setDet] = useState('');
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(4);
  const [mode, setMode] = useState<ViewMode>('normal');
  const [gain, setGain] = useState(10);
  const [zoom, setZoom] = useState(1);
  const [minValid, setMinValid] = useState(60); // min % of pixels with data for a frame to enter the video
  const [autoCrop, setAutoCrop] = useState(false);
  const [showMark, setShowMark] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportPct, setExportPct] = useState(0);
  const [panel, setPanel] = useState<null | 'help' | 'info'>(null);
  const [showCtl, setShowCtl] = useState(false); // mobile only: toggles the sliders

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const selRef = useRef(selectedKey);
  selRef.current = selectedKey;
  const detRef = useRef(det);
  detRef.current = det;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const dets = useMemo(() => {
    const m = new Map<string, number>();
    frames.forEach((f) => m.set(detOf(f), (m.get(detOf(f)) || 0) + 1));
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [frames]);

  const bandLabel = useMemo(() => {
    const seen = new Map<string, Set<string>>();
    frames.forEach((f) => {
      const d = detOf(f);
      const b = String(f?.energy_bandpassname || '').trim();
      if (!b || b.toUpperCase() === d) return;
      if (!seen.has(d)) seen.set(d, new Set());
      seen.get(d)!.add(b);
    });
    const out = new Map<string, string>();
    seen.forEach((s, d) => out.set(d, [...s].slice(0, 2).join(' / ').slice(0, 28)));
    return out;
  }, [frames]);

  // Initial detector: the selected observation's, else the one with the most frames
  useEffect(() => {
    if (!dets.length || dets.some(([d]) => d === det)) return;
    const selFrame = frames.find((f) => keyOf(f) === selRef.current);
    const pref = selFrame ? detOf(selFrame) : [...dets].sort((a, b) => b[1] - a[1])[0][0];
    setDet(pref);
  }, [dets, det, frames]);

  useEffect(() => {
    if (!selectedKey) return;
    const f = frames.find((x) => keyOf(x) === selectedKey);
    if (f && detOf(f) !== detRef.current) setDet(detOf(f));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  useEffect(() => {
    if (!visible) setPlaying(false);
  }, [visible]);

  const list = useMemo(() => sortByTime(frames.filter((f) => detOf(f) === det)), [frames, det]);
  const summary = useMemo(() => summarize(list), [list]);
  const listKey = useMemo(() => list.map(keyOf).join('\n'), [list]);

  useEffect(() => {
    setTarget({ ra: center.ra, dec: center.dec, fov: center.fov });
    want(active ? list.map(keyOf) : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, listKey, center.ra, center.dec, center.fov]);

  const st = useMemo(() => {
    const ready: any[] = [];
    let nocov = 0, err = 0, low = 0, pending = 0;
    for (const f of list) {
      const s = getSlot(keyOf(f));
      if (!s || s.status === 'queued' || s.status === 'loading') pending++;
      else if (s.status === 'nocov') nocov++;
      else if (s.status === 'err') err++;
      else if (s.loaded!.valid * 100 >= minValid) ready.push(f);
      else low++;
    }
    return { ready, nocov, err, low, pending };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, version, minValid]);
  const ready = st.ready;

  const statusOf = (f: any): Status => {
    const s = getSlot(keyOf(f));
    if (!s || s.status === 'queued') return 'pending';
    if (s.status === 'loading') return 'loading';
    if (s.status === 'ok') return s.loaded!.valid * 100 >= minValid ? 'ok' : 'low';
    return s.status;
  };

  const curIdx = ready.findIndex((f) => keyOf(f) === selectedKey);
  const cur = curIdx >= 0 ? curIdx : 0;
  const curFrame = ready[cur];
  const curKey = curFrame ? keyOf(curFrame) : '';
  const curLoaded = curKey ? getSlot(curKey)?.loaded : undefined;

  useEffect(() => {
    if (!ready.length || curIdx >= 0) return;
    // A selection from another detector is handled by the effect above: don't fight it
    const selFrame = frames.find((f) => keyOf(f) === selRef.current);
    if (selFrame && detOf(selFrame) !== det) return;
    onSelectRef.current(keyOf(ready[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, curIdx, det]);

  // Common rectangle with no holes across all ready frames (falls back to 80% of them if too small)
  const crop = useMemo<Crop | null>(() => {
    if (ready.length === 0) return null;
    const first = getSlot(keyOf(ready[0]))!.loaded!;
    const n = first.n;
    const full: Crop = { n, x: 0, y: 0, w: n, h: n };
    if (!autoCrop) return full;
    const arrs = ready.map((f) => getSlot(keyOf(f))!.loaded!).filter((a) => a.n === n);
    const cnt = new Uint16Array(n * n);
    for (const a of arrs) for (let p = 0; p < n * n; p++) if (Number.isFinite(a.data[p])) cnt[p]++;
    let r = largestRect(cnt, n, arrs.length);
    if (r.area < 0.25 * n * n) r = largestRect(cnt, n, Math.ceil(arrs.length * 0.8));
    if (r.area < 0.05 * n * n) return full;
    return { n, x: r.x, y: r.y, w: r.w, h: r.h };
  }, [ready, autoCrop]);

  const stack = useMemo(() => {
    if (mode === 'normal' || ready.length < 2) return null;
    const all = ready.map((f) => getSlot(keyOf(f))!.loaded!);
    const n = all[0].n;
    const arrs = all.filter((a) => a.n === n);
    const out = new Float32Array(n * n);
    const buf: number[] = [];
    for (let p = 0; p < n * n; p++) {
      buf.length = 0;
      for (const a of arrs) {
        const v = a.data[p];
        if (Number.isFinite(v)) buf.push(v);
      }
      if (!buf.length) { out[p] = NaN; continue; }
      if (mode === 'mean') {
        let s = 0;
        for (const v of buf) s += v;
        out[p] = s / buf.length;
      } else {
        buf.sort((x, y) => x - y);
        out[p] = buf[buf.length >> 1];
      }
    }
    return out;
  }, [ready, mode]);

  const readyRef = useRef(ready);
  readyRef.current = ready;
  useEffect(() => {
    if (!playing || ready.length < 2 || mode === 'mean') return;
    const t = setInterval(() => {
      const r = readyRef.current;
      if (r.length < 2) return;
      const i = r.findIndex((f) => keyOf(f) === selRef.current);
      onSelectRef.current(keyOf(r[(i + 1) % r.length]));
    }, 1000 / fps);
    return () => clearInterval(t);
  }, [playing, fps, ready.length, mode]);

  const buildImage = (i: number): ImageData | null => {
    if (!crop || !ready[i]) return null;
    const e = getSlot(keyOf(ready[i]))?.loaded;
    if (!e || e.n !== crop.n) return null;
    const { n, x, y, w, h } = crop;
    const vals = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let k = 0; k < w; k++) {
        const p = (y + j) * n + (x + k);
        let v = e.data[p];
        if (mode === 'mean' && stack) v = stack[p];
        else if (mode === 'medsub' && stack) v = e.data[p] - stack[p];
        vals[j * w + k] = v;
      }
    }
    return renderImage(vals, w, h, gain);
  };

  useEffect(() => {
    if (!visible) return;
    const cv = canvasRef.current;
    if (!cv || !crop) return;
    const img = buildImage(cur);
    if (!img) return;
    cv.width = crop.w;
    cv.height = crop.h;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(img, 0, 0);
    if (showMark) {
      // The target sits at the center of the original grid: (n-1)/2, as in sky.ts
      const mx = (crop.n - 1) / 2 - crop.x;
      const my = (crop.n - 1) / 2 - crop.y;
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.85)';
      ctx.lineWidth = Math.max(1, Math.max(crop.w, crop.h) / 220);
      ctx.beginPath();
      ctx.arc(mx, my, Math.max(4, Math.max(crop.w, crop.h) * 0.03), 0, Math.PI * 2);
      ctx.stroke();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, curKey, mode, gain, ready, stack, crop, showMark]);

  useEffect(() => {
    if (!visible) return;
    const i = list.findIndex((f) => keyOf(f) === curKey);
    if (i < 0) return;
    stripRef.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [curKey, visible, list]);

  // Exports a .webm video (or a PNG in "Stacked" mode)
  const exportMedia = async () => {
    if (!crop || ready.length === 0 || exporting) return;
    setExporting(true);
    setExportPct(0);
    try {
      const scale = Math.max(1, Math.ceil(EXPORT_MIN_SIDE / Math.max(crop.w, crop.h)));
      const W = crop.w * scale;
      const H = crop.h * scale;
      const out = document.createElement('canvas');
      out.width = W;
      out.height = H;
      const octx = out.getContext('2d');
      const tmp = document.createElement('canvas');
      tmp.width = crop.w;
      tmp.height = crop.h;
      const tctx = tmp.getContext('2d');
      if (!octx || !tctx) throw new Error('canvas unavailable');

      const fontPx = Math.max(12, Math.round(H / 32));
      const drawFrame = (i: number) => {
        const img = buildImage(i);
        if (!img) return;
        tctx.putImageData(img, 0, 0);
        octx.imageSmoothingEnabled = false;
        octx.drawImage(tmp, 0, 0, W, H);
        const label = mode === 'mean' ? `${det} · mean of ${ready.length} frames` : `${det} · ${ready[i]?.date || ''}`;
        octx.font = `${fontPx}px ui-monospace, monospace`;
        octx.textBaseline = 'bottom';
        octx.fillStyle = 'rgba(0,0,0,0.55)';
        octx.fillRect(0, H - fontPx * 1.6, octx.measureText(label).width + fontPx, fontPx * 1.6);
        octx.fillStyle = '#fff';
        octx.fillText(label, fontPx / 2, H - fontPx * 0.3);
      };

      const baseName = `spherex_${center.ra}_${center.dec}_${det}_${mode}`;

      if (mode === 'mean' || ready.length < 2) {
        drawFrame(cur);
        await new Promise<void>((res) => out.toBlob((b) => { if (b) saveBlob(b, `${baseName}.png`); res(); }, 'image/png'));
        return;
      }
      if (typeof MediaRecorder === 'undefined') {
        alert('This browser does not support video recording. Use Chrome, Edge or Firefox.');
        return;
      }
      const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
      if (!mime) {
        alert('This browser cannot record .webm. Use Chrome, Edge or Firefox.');
        return;
      }
      const stream = out.captureStream(fps);
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const stopped = new Promise<void>((res) => { rec.onstop = () => res(); });

      drawFrame(0);
      rec.start();
      for (let i = 0; i < ready.length; i++) {
        drawFrame(i);
        setExportPct(Math.round(((i + 1) / ready.length) * 100));
        await wait(1000 / fps);
      }
      await wait(1000 / fps);
      rec.stop();
      await stopped;
      saveBlob(new Blob(chunks, { type: 'video/webm' }), `${baseName}.webm`);
    } catch (e: any) {
      alert(`Export failed: ${e?.message || e}`);
    } finally {
      setExporting(false);
    }
  };

  // Tick positions by date (evenly spaced if any date is missing)
  const axis = useMemo(() => {
    const n = list.length;
    const ts = list.map(timeOf);
    const ok = n > 0 && ts.every((t) => t !== null);
    const t0 = ok ? Math.min(...(ts as number[])) : 0;
    const t1 = ok ? Math.max(...(ts as number[])) : 0;
    const span = t1 - t0;
    const pos = list.map((_, i) => (ok && span > 0 ? ((ts[i] as number) - t0) / span : n > 1 ? i / (n - 1) : 0.5));
    const bands = ok && span > 0 ? summary.groups.map((g) => ({ l: (g.t0 - t0) / span, w: (g.t1 - g.t0) / span })) : [];
    return { pos, bands };
  }, [list, summary]);

  const pick = (f: any) => {
    if (statusOf(f) !== 'ok') return;
    setPlaying(false);
    onSelect(keyOf(f));
  };
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const onPick = useCallback((f: any) => pickRef.current(f), []);

  const changeDet = (d: string) => {
    setDet(d);
    const first = sortByTime(frames.filter((f) => detOf(f) === d))[0];
    if (first) onSelectRef.current(keyOf(first));
  };

  const goto = (i: number) => {
    if (!ready.length) return;
    onSelect(keyOf(ready[Math.max(0, Math.min(ready.length - 1, i))]));
  };

  const eta =
    pr.finished >= 2 && pr.pending > 0
      ? `${fmtEta((pr.elapsedMs / pr.finished) * pr.pending)} left`
      : 'each frame takes 10–25 s from IRSA';

  // text-base on mobile prevents iOS auto-zoom when focusing the select
  const sel = 'bg-gray-800 border border-gray-700 rounded px-2 py-1.5 md:py-1 text-base md:text-xs text-white outline-none';
  const aspect = crop ? crop.w / crop.h : 1;
  const sumText =
    summary.t0 !== null
      ? `${mjdToDate(summary.t0)} → ${mjdToDate(summary.t1!)} (${Math.round(summary.spanDays!)} days) · ${summary.groups.length} observation period(s)`
      : 'observations have no date in the query';

  const showLoadingPanel = !det || (list.length > 0 && st.pending > 0);

  return (
    <div className="absolute inset-0 flex flex-col bg-black">
      <div className="flex flex-wrap items-center gap-2 p-2 text-xs bg-gray-900/90 border-b border-gray-800">
        <select
          value={det}
          onChange={(e) => changeDet(e.target.value)}
          className={sel}
          title="Each detector covers an infrared color band. Compare frames from the same detector."
        >
          {dets.map(([d, n]) => (
            <option key={d} value={d} className="bg-gray-900">
              {d}
              {bandLabel.get(d) ? ` · ${bandLabel.get(d)}` : ''} ({n})
            </option>
          ))}
        </select>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as ViewMode)}
          className={sel}
          title="Normal: as received. − median: removes what is fixed, leaving only what moves or varies. Stacked: mean of all dates, to reveal faint things."
        >
          <option value="normal" className="bg-gray-900">Normal</option>
          <option value="medsub" className="bg-gray-900">− median (highlights movers)</option>
          <option value="mean" className="bg-gray-900">Stacked (mean)</option>
        </select>

        <button
          onClick={() => setShowCtl((s) => !s)}
          className={`md:hidden px-3 py-1.5 rounded border ${showCtl ? 'bg-blue-600 border-blue-400 text-white' : 'bg-gray-800 border-gray-700 text-gray-300'}`}
        >
          ⚙ settings
        </button>

        {/* Mobile: own row, toggled. Desktop (md:contents): items sit inline in the bar */}
        <div className={`${showCtl ? 'flex' : 'hidden'} md:contents flex-wrap items-center gap-x-3 gap-y-2 w-full`}>
          <label className="flex items-center gap-1 text-gray-400">
            speed
            <input type="range" min={1} max={12} value={fps} onChange={(e) => setFps(+e.target.value)} />
            {fps} fps
          </label>
          <label className="flex items-center gap-1 text-gray-400" title="Higher shows fainter objects (and more noise)">
            contrast
            <input type="range" min={3} max={40} value={gain} onChange={(e) => setGain(+e.target.value)} />
          </label>
          <label className="flex items-center gap-1 text-gray-400">
            zoom
            <input type="range" min={1} max={8} step={0.5} value={zoom} onChange={(e) => setZoom(+e.target.value)} />
            {zoom}x
          </label>
          <label className="flex items-center gap-1 text-gray-400" title="Frames where the detector covers less than this share of the area are left out of the video">
            min. coverage
            <input type="range" min={0} max={100} step={5} value={minValid} onChange={(e) => setMinValid(+e.target.value)} />
            {minValid}%
          </label>
          <label
            className="flex items-center gap-1 text-gray-400"
            title="Removes borders without common coverage across frames. Off shows the full grid."
          >
            <input type="checkbox" checked={autoCrop} onChange={(e) => setAutoCrop(e.target.checked)} />
            auto crop
          </label>
          <label className="flex items-center gap-1 text-gray-400" title="Yellow circle at the typed position (catalog, J2000 epoch)">
            <input type="checkbox" checked={showMark} onChange={(e) => setShowMark(e.target.checked)} />
            mark target
          </label>
        </div>

        <button
          onClick={exportMedia}
          disabled={exporting || ready.length === 0}
          className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-3 py-1.5 md:py-0.5 rounded-full text-white"
          title="Records the displayed frames to a video (.webm). In Stacked mode, downloads a PNG."
        >
          {exporting ? `Recording... ${exportPct}%` : mode === 'mean' || ready.length < 2 ? 'Download PNG' : 'Download video (.webm)'}
        </button>
        {st.err > 0 && (
          <button onClick={retryErrors} className="bg-blue-600 hover:bg-blue-500 px-3 py-1.5 md:py-0.5 rounded-full text-white">
            Retry {st.err} errors
          </button>
        )}
        <span className="hidden md:block flex-1" />
        <button onClick={() => setPanel((p) => (p === 'help' ? null : 'help'))} className="px-2 py-1.5 md:py-0.5 rounded bg-gray-800 hover:bg-gray-700">? help</button>
        <button onClick={() => setPanel((p) => (p === 'info' ? null : 'info'))} className="px-2 py-1.5 md:py-0.5 rounded bg-gray-800 hover:bg-gray-700">ⓘ details</button>
      </div>

      <div className="px-3 py-1 text-[11px] text-gray-300 bg-gray-900/60 border-b border-gray-800 font-mono truncate">
        {det || '—'}: {summary.count} observations · {sumText}
      </div>

      <div className="flex-1 min-h-0 relative overflow-hidden flex items-center justify-center">
        {frames.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-xs text-gray-400 px-6 text-center">
            {searching ? (
              <>
                <Radar size={64} />
                <span>Searching IRSA for observations… {searchSecs}s</span>
                <span className="text-[11px] text-gray-600">can take up to 30 s if IRSA is slow</span>
              </>
            ) : (
              <span className="max-w-lg leading-relaxed">{emptyMessage || 'No observations for this target.'}</span>
            )}
          </div>
        ) : ready.length > 0 ? (
          <div
            className="relative"
            style={{
              aspectRatio: `${aspect}`,
              height: aspect <= 1 ? '100%' : undefined,
              width: aspect > 1 ? '100%' : undefined,
              maxWidth: '100%',
              maxHeight: '100%',
              transform: `scale(${zoom})`,
            }}
          >
            <canvas ref={canvasRef} className="w-full h-full" style={{ imageRendering: 'pixelated' }} />
          </div>
        ) : showLoadingPanel ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6">
            <Radar size={64} />
            <Steps
              items={[
                { label: `${frames.length} observations found · ${list.length} on detector ${det || '…'}`, state: 'done' },
                { label: `Downloading and aligning frames (${pr.done}/${pr.total})`, state: 'active' },
                { label: 'Building the video', state: 'todo' },
              ]}
            />
            <div className="w-64 max-w-full">
              <Bar value={pr.total ? pr.done / pr.total : 0} indeterminate={pr.done === 0} />
            </div>
            <span className="text-[11px] text-gray-500">{eta}</span>
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-500 px-6 text-center">
            {list.length === 0
              ? 'No frames from this detector for this target.'
              : st.low > 0 && st.pending === 0
              ? `${st.low} frame(s) arrived, but all have coverage below ${minValid}%. Lower "min. coverage".`
              : `No frames from this detector became available: ${st.err} error(s), ${st.nocov} without coverage. Try another detector${st.err ? ' or use "Retry"' : ''}.`}
          </div>
        )}

        {ready.length > 0 && pr.pending > 0 && (
          <div className="absolute left-2 bottom-2 z-10 w-48 md:w-60 bg-gray-900/90 border border-gray-700 rounded p-2 flex flex-col gap-1 pointer-events-none">
            <span className="text-[10px] text-gray-300 font-mono">
              Downloading more frames: {pr.done}/{pr.total} · {eta}
            </span>
            <Bar value={pr.total ? pr.done / pr.total : 0} />
          </div>
        )}

        {panel === 'help' && (
          <div className="absolute top-2 left-2 right-2 max-w-xl max-h-[90%] overflow-auto z-10 bg-gray-900/95 border border-gray-700 rounded p-3 text-[11px] text-gray-300 leading-relaxed">
            <b className="text-white">How to read this screen.</b> The point you chose was imaged several times by SPHEREx.
            Each tick on the time axis is one observation; the gray blocks are consecutive observation periods, grouped
            automatically, and the gaps between them are pauses. The image shows the same patch of sky on each date:
            what is fixed stays still, and what moves between dates is a candidate asteroid, comet or nearby star.
            "− median" mode erases what does not change and leaves only what varies. Each detector sees one infrared color band,
            and color shifts across the image, so compare frames from the same detector. Tap a tick or a thumbnail to jump to that observation.
          </div>
        )}
        {panel === 'info' && (
          <div className="absolute top-2 right-2 w-[calc(100%-1rem)] md:w-96 max-h-[80%] overflow-auto z-10 bg-gray-900/95 border border-gray-700 rounded p-3 text-[10px] text-gray-300 font-mono">
            <div className="text-white mb-1">Current frame: {curFrame?.date || '—'} · {det}</div>
            <pre className="whitespace-pre-wrap break-all">
              {curLoaded?.info ? JSON.stringify(curLoaded.info, null, 1) : 'No metadata (update /api/align to the new version).'}
            </pre>
          </div>
        )}
      </div>

      <div className="px-3 pt-2 bg-gray-900/90 border-t border-gray-800">
        <div className="relative h-8 mx-1" title="Each tick is an observation, placed at its date">
          {axis.bands.map((b, i) => (
            <div key={i} className="absolute top-2.5 h-3 rounded bg-gray-800" style={{ left: `${b.l * 100}%`, width: `${Math.max(b.w * 100, 0.8)}%` }} />
          ))}
          {visible &&
            list.map((f, i) => {
              const k = keyOf(f);
              return <Tick key={k} f={f} left={axis.pos[i]} isCur={k === curKey} status={statusOf(f)} onPick={onPick} />;
            })}
        </div>
        <div className="flex justify-between text-[10px] text-gray-500 font-mono mx-1">
          <span>{summary.t0 !== null ? mjdToDate(summary.t0) : ''}</span>
          <span>{summary.t1 !== null ? mjdToDate(summary.t1) : ''}</span>
        </div>
      </div>

      <div className="p-2 bg-gray-900/90 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <button
          onClick={() => setPlaying((p) => !p)}
          disabled={ready.length < 2 || mode === 'mean'}
          className="w-20 md:w-16 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded py-1.5 md:py-1 text-white"
        >
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <button onClick={() => goto(cur - 1)} className="px-3 md:px-2 py-1.5 md:py-1 bg-gray-800 rounded">◀</button>
        <input
          type="range"
          min={0}
          max={Math.max(0, ready.length - 1)}
          value={cur}
          onChange={(e) => { setPlaying(false); goto(+e.target.value); }}
          className="flex-1 min-w-[6rem]"
        />
        <button onClick={() => goto(cur + 1)} className="px-3 md:px-2 py-1.5 md:py-1 bg-gray-800 rounded">▶</button>
        <span className="font-mono text-gray-300 w-full md:w-auto md:min-w-56 text-left md:text-right order-last md:order-none">
          {mode === 'mean'
            ? `mean of ${ready.length} frames`
            : ready.length
            ? `${cur + 1}/${ready.length} · ${curFrame?.date || '—'}${curLoaded ? ` · ${Math.round(curLoaded.valid * 100)}% cov.` : ''}`
            : '—'}
        </span>
        <span className="font-mono text-gray-500 w-full md:w-auto order-last md:order-none text-[11px] md:text-xs">
          {ready.length}/{list.length} ok
          {st.pending > 0 ? ` · ${st.pending} downloading` : ''}
          {st.low ? ` · ${st.low} discarded` : ''}
          {st.nocov ? ` · ${st.nocov} no cov.` : ''}
          {st.err ? ` · ${st.err} errors` : ''}
        </span>
      </div>

      <div ref={stripRef} className="h-24 md:h-28 shrink-0 flex gap-1.5 overflow-x-auto overflow-y-hidden p-2 bg-gray-950 border-t border-gray-800">
        {visible &&
          list.map((f, i) => {
            const k = keyOf(f);
            const s = getSlot(k);
            return (
              <StripItem
                key={k}
                f={f}
                i={i}
                isCur={k === curKey}
                status={statusOf(f)}
                loaded={s?.status === 'ok' ? s.loaded : undefined}
                gain={gain}
                onPick={onPick}
              />
            );
          })}
      </div>
    </div>
  );
}

export default memo(TimelinePlayer);