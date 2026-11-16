import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

type Row = Record<string, string>;
type Attempt = { n: number; ms: number; status: number | string; note?: string; via?: string };
type Result = { rows: Row[]; attempts: Attempt[]; via: string };

const COLLECTIONS = ['spherex_dr1', 'spherex_qr3'];
const DISK_FRESH_MS = 12 * 60 * 60 * 1000;
const inflight = new Map<string, Promise<Result>>();

const isLevel2 = (url: string) => /\.fits$/i.test(url) && url.includes('/level2/');
const isCurrent = (url: string) => /\/(dr1|qr3)\//.test(url);

const diskPath = (key: string) =>
  path.join(process.cwd(), '.cache', `spherex-${key.replace(/[^\w.-]/g, '_')}.json`);

function diskRead(key: string, maxAgeMs = Infinity): Row[] | null {
  try {
    const p = diskPath(key);
    if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) return null;
    const rows = JSON.parse(fs.readFileSync(p, 'utf8'));
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

function diskWrite(key: string, rows: Row[]) {
  try {
    fs.mkdirSync(path.dirname(diskPath(key)), { recursive: true });
    fs.writeFileSync(diskPath(key), JSON.stringify(rows));
  } catch {}
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function csvToRows(text: string): Row[] {
  const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']));
  });
}

const mjdToDate = (v?: string) => {
  const n = parseFloat(v || '');
  return Number.isFinite(n) && n > 10000 && n < 100000 ? new Date((n - 40587) * 86400000).toISOString().slice(0, 10) : '';
};

const dedupe = (rows: Row[]) => [...new Map(rows.map((r) => [r.access_url, r])).values()];

async function getText(url: string, via: string, attempts: Attempt[], tries: number, timeoutMs: number) {
  let lastError = '';
  for (let i = 0; i < tries; i++) {
    const t0 = Date.now();
    let status: number | string = 'failed';
    let note = '';
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      status = res.status;
      if (res.ok && !text.trim().startsWith('<')) {
        attempts.push({ n: attempts.length + 1, ms: Date.now() - t0, status, via });
        return text;
      }
      const title = text.match(/<title>(.*?)<\/title>/i)?.[1];
      note = title || text.replace(/\s+/g, ' ').slice(0, 160);
      lastError = `${via}: HTTP ${status}${title ? ` (${title})` : ''}`;
    } catch (e: any) {
      note = e?.name === 'TimeoutError' ? `timeout after ${timeoutMs / 1000}s` : e?.message || 'network error';
      lastError = `${via}: ${note}`;
    }
    attempts.push({ n: attempts.length + 1, ms: Date.now() - t0, status, note, via });
    if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) break;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  throw new Error(lastError);
}

async function queryTap(ra: number, dec: number, attempts: Attempt[]): Promise<Row[]> {
  const adql = `SELECT TOP 400
  'https://irsa.ipac.caltech.edu/' || a.uri AS access_url,
  p.obs_publisher_did,
  p.time_bounds_lower,
  p.energy_bandpassname
FROM spherex.artifact a
JOIN spherex.plane p ON a.planeid = p.planeid
WHERE 1 = CONTAINS(POINT('ICRS', ${ra}, ${dec}), p.poly)
ORDER BY p.time_bounds_lower`;

  const params = new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: adql });
  const text = await getText(`https://irsa.ipac.caltech.edu/TAP/sync?${params}`, 'TAP', attempts, 2, 20000);

  const raw = csvToRows(text);
  const rows = dedupe(
    raw
      .filter((r) => r.access_url && isLevel2(r.access_url) && isCurrent(r.access_url))
      .map((r) => ({ ...r, date: mjdToDate(r.time_bounds_lower) }))
  );
  attempts.push({
    n: attempts.length + 1,
    ms: 0,
    status: 'info',
    via: 'TAP',
    note: `${raw.length} raw rows, ${rows.length} level2 images (DR1/QR3)`,
  });
  return rows;
}

async function querySia(ra: number, dec: number, size: string, attempts: Attempt[]): Promise<Row[]> {
  const results = await Promise.allSettled(
    COLLECTIONS.map((c) =>
      getText(
        `https://irsa.ipac.caltech.edu/SIA?COLLECTION=${c}&POS=circle+${ra}+${dec}+${size}&RESPONSEFORMAT=CSV`,
        `SIA ${c}`,
        attempts,
        1,
        15000
      )
    )
  );
  const ok = results.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled');
  if (!ok.length) throw new Error('SIA: no collection responded');

  return dedupe(
    ok
      .flatMap((r) => csvToRows(r.value))
      .filter((r) => r.access_url && isLevel2(r.access_url))
      .map((r) => ({ ...r, date: r.date || mjdToDate(r.t_min) }))
  );
}

async function fetchRows(ra: number, dec: number, size: string): Promise<Result> {
  const attempts: Attempt[] = [];
  const tap = queryTap(ra, dec, attempts).then((rows) => ({ rows, attempts, via: 'TAP' }));
  const sia = querySia(ra, dec, size, attempts).then((rows) => {
    if (!rows.length) throw new Error('SIA: no results');
    return { rows, attempts, via: 'SIA' };
  });
  try {
    return await Promise.any([tap, sia]);
  } catch (e: any) {
    const message = (e.errors || []).map((x: any) => x.message).join(' | ') || e.message;
    throw Object.assign(new Error(message), { attempts });
  }
}

export async function GET(request: Request) {
  const t0 = Date.now();
  const params = new URL(request.url).searchParams;
  const ra = parseFloat(params.get('ra') || '');
  const dec = parseFloat(params.get('dec') || '');
  const size = params.get('size') || '0.05';

  if (!Number.isFinite(ra) || !Number.isFinite(dec)) {
    return NextResponse.json({ error: 'Invalid RA/Dec' }, { status: 400 });
  }

  const key = `${ra},${dec}`;

  const fresh = diskRead(key, DISK_FRESH_MS);
  if (fresh) {
    return NextResponse.json({ data: fresh, debug: { source: 'disk cache', elapsedMs: Date.now() - t0 } });
  }

  let job = inflight.get(key);
  if (!job) {
    job = fetchRows(ra, dec, size).finally(() => inflight.delete(key));
    inflight.set(key, job);
  }

  try {
    const { rows, attempts, via } = await job;
    if (via === 'TAP' && rows.length) diskWrite(key, rows);
    return NextResponse.json({ data: rows, debug: { source: via, attempts, elapsedMs: Date.now() - t0 } });
  } catch (error: any) {
    const attempts: Attempt[] = error.attempts || [];
    console.error(`[spherex ${key}] failed: ${error.message}`);

    const stale = diskRead(key);
    if (stale) {
      return NextResponse.json({
        data: stale,
        debug: { source: 'disk cache', stale: true, error: error.message, attempts, elapsedMs: Date.now() - t0 },
      });
    }

    return NextResponse.json(
      { error: 'IRSA did not respond (TAP and SIA).', debug: { error: error.message, attempts, elapsedMs: Date.now() - t0 } },
      { status: 502 }
    );
  }
}