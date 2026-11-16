import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { D2R, R2D, skyToTangent, tangentToSky, gridToTangentDeg } from '../../../lib/sky';
import { acquire, release, fetchBuffer } from '../../../lib/irsa';

type Hdu = { header: Record<string, string>; dataStart: number };
type Sip = [number, number, number][];
type Wcs = {
  crval: [number, number];
  crpix: [number, number];
  inv: [[number, number], [number, number]];
  sipA: Sip;
  sipB: Sip;
};
type Aligned = { buf: Buffer; info: string };
type Job = { promise: Promise<Aligned>; ctrl: AbortController; refs: number };

const PNG_VERSION = 1;
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const STEP = 4;
const DIR = path.join(process.cwd(), '.cache', 'align');
const inflight = new Map<string, Job>();

const file = (key: string, ext: string) => path.join(DIR, createHash('sha1').update(key).digest('hex') + ext);
const binFile = (key: string) => file(key, '.bin');
const nocovFile = (key: string) => file(key, '.nocov');
const pngFile = (key: string) => file(key, `.v${PNG_VERSION}.png`);

function readAligned(key: string): Aligned | null {
  try {
    const f = fs.readFileSync(binFile(key));
    const len = f.readUInt32BE(0);
    return { info: f.toString('utf8', 4, 4 + len), buf: f.subarray(4 + len) };
  } catch {
    return null;
  }
}

function writeAligned(key: string, { buf, info }: Aligned) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const head = Buffer.from(info, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(head.length, 0);
    fs.writeFileSync(binFile(key), Buffer.concat([len, head, buf]));
  } catch {}
}

function markNoCoverage(key: string) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(nocovFile(key), '');
  } catch {}
}

function joinJob(key: string, make: (signal: AbortSignal) => Promise<Aligned>, signal: AbortSignal) {
  let job = inflight.get(key);
  if (!job) {
    const ctrl = new AbortController();
    job = { promise: make(ctrl.signal).finally(() => inflight.delete(key)), ctrl, refs: 0 };
    inflight.set(key, job);
  }
  const j = job;
  j.refs++;
  const onAbort = () => {
    if (--j.refs <= 0) j.ctrl.abort();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return j.promise.finally(() => signal.removeEventListener('abort', onAbort));
}

function parseHdus(buf: Buffer): Hdu[] {
  const hdus: Hdu[] = [];
  let offset = 0;
  while (offset + 2880 <= buf.length) {
    const header: Record<string, string> = {};
    let ended = false;
    while (!ended && offset + 2880 <= buf.length) {
      for (let i = 0; i < 36 && !ended; i++) {
        const card = buf.toString('ascii', offset + i * 80, offset + (i + 1) * 80);
        const key = card.slice(0, 8).trim();
        if (key === 'END') ended = true;
        else if (card[8] === '=') header[key] = card.slice(10).split('/')[0].trim().replace(/^'|'$/g, '').trim();
      }
      offset += 2880;
    }
    if (!ended) break;

    const int = (k: string, d: number) => {
      const v = parseInt(header[k], 10);
      return Number.isNaN(v) ? d : v;
    };
    const naxis = int('NAXIS', 0);
    let size = naxis > 0 ? 1 : 0;
    for (let n = 1; n <= naxis; n++) size *= int(`NAXIS${n}`, 0);
    const dataBytes = (Math.abs(int('BITPIX', 8)) / 8) * int('GCOUNT', 1) * (int('PCOUNT', 0) + size);

    hdus.push({ header, dataStart: offset });
    offset += Math.ceil(dataBytes / 2880) * 2880;
  }
  return hdus;
}

const num = (h: Record<string, string>, k: string, d = NaN) => {
  const v = h[k] === undefined ? NaN : parseFloat(h[k].replace(/[dD]/, 'E'));
  return Number.isFinite(v) ? v : d;
};

function readSip(h: Record<string, string>, p: 'A' | 'B'): Sip {
  const order = num(h, `${p}_ORDER`, 0);
  const out: Sip = [];
  for (let a = 0; a <= order; a++) {
    for (let b = 0; a + b <= order; b++) {
      const c = a + b < 2 ? 0 : num(h, `${p}_${a}_${b}`, 0);
      if (c !== 0) out.push([a, b, c]);
    }
  }
  return out;
}

function readWcs(h: Record<string, string>): Wcs {
  const ctype = h['CTYPE1'] || '';
  if (!ctype.includes('TAN')) throw new Error(`Unsupported WCS projection: "${ctype || 'missing CTYPE1'}"`);

  const crval: [number, number] = [num(h, 'CRVAL1'), num(h, 'CRVAL2')];
  const crpix: [number, number] = [num(h, 'CRPIX1'), num(h, 'CRPIX2')];
  if (!Number.isFinite(crval[0]) || !Number.isFinite(crpix[0])) throw new Error('Header missing CRVAL/CRPIX');

  let cd: [[number, number], [number, number]];
  if (Number.isFinite(num(h, 'CD1_1'))) {
    cd = [
      [num(h, 'CD1_1'), num(h, 'CD1_2', 0)],
      [num(h, 'CD2_1', 0), num(h, 'CD2_2')],
    ];
  } else {
    const d1 = num(h, 'CDELT1');
    const d2 = num(h, 'CDELT2');
    if (!Number.isFinite(d1) || !Number.isFinite(d2)) throw new Error('Header has neither CD nor CDELT');
    cd = [
      [d1 * num(h, 'PC1_1', 1), d1 * num(h, 'PC1_2', 0)],
      [d2 * num(h, 'PC2_1', 0), d2 * num(h, 'PC2_2', 1)],
    ];
  }
  const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
  if (!det) throw new Error('Singular CD matrix');

  return {
    crval,
    crpix,
    inv: [
      [cd[1][1] / det, -cd[0][1] / det],
      [-cd[1][0] / det, cd[0][0] / det],
    ],
    sipA: readSip(h, 'A'),
    sipB: readSip(h, 'B'),
  };
}

const sipEval = (c: Sip, u: number, v: number) => c.reduce((s, [a, b, k]) => s + k * Math.pow(u, a) * Math.pow(v, b), 0);

function worldToPixel(w: Wcs, raDeg: number, decDeg: number): [number, number] | null {
  const t = skyToTangent(raDeg * D2R, decDeg * D2R, w.crval[0] * D2R, w.crval[1] * D2R);
  if (!t) return null;
  const x = t.xi * R2D;
  const y = t.eta * R2D;
  const U = w.inv[0][0] * x + w.inv[0][1] * y;
  const V = w.inv[1][0] * x + w.inv[1][1] * y;
  let u = U;
  let v = V;
  if (w.sipA.length || w.sipB.length) {
    for (let it = 0; it < 8; it++) {
      u = U - sipEval(w.sipA, u, v);
      v = V - sipEval(w.sipB, u, v);
    }
  }
  return [u + w.crpix[0] - 1, v + w.crpix[1] - 1];
}

function makePixelMapper(wcs: Wcs, ra0: number, dec0: number, n: number, scale: number) {
  const exact = (i: number, j: number): [number, number] | null => {
    const g = gridToTangentDeg(i, j, n, scale);
    const sky = tangentToSky(g.xi * D2R, g.eta * D2R, ra0, dec0);
    return worldToPixel(wcs, sky.ra * R2D, sky.dec * R2D);
  };

  const m = Math.ceil((n - 1) / STEP) + 2;
  const nx = new Float64Array(m * m);
  const ny = new Float64Array(m * m);
  const ok = new Uint8Array(m * m);
  for (let jj = 0; jj < m; jj++) {
    for (let ii = 0; ii < m; ii++) {
      const p = exact(ii * STEP, jj * STEP);
      if (p) {
        const k = jj * m + ii;
        nx[k] = p[0];
        ny[k] = p[1];
        ok[k] = 1;
      }
    }
  }

  return (i: number, j: number): [number, number] | null => {
    const ci = Math.floor(i / STEP);
    const cj = Math.floor(j / STEP);
    const a = cj * m + ci;
    const b = a + 1;
    const c = a + m;
    const d = c + 1;
    if (!(ok[a] && ok[b] && ok[c] && ok[d])) return exact(i, j);
    const fx = (i - ci * STEP) / STEP;
    const fy = (j - cj * STEP) / STEP;
    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;
    return [
      nx[a] * w00 + nx[b] * w10 + nx[c] * w01 + nx[d] * w11,
      ny[a] * w00 + ny[b] * w10 + ny[c] * w01 + ny[d] * w11,
    ];
  };
}

function median(values: ArrayLike<number>, q = 0.5) {
  const sample: number[] = [];
  const stride = Math.max(1, Math.floor(values.length / 20000));
  for (let k = 0; k < values.length; k += stride) if (Number.isFinite(values[k])) sample.push(values[k]);
  sample.sort((a, b) => a - b);
  return sample.length ? sample[Math.floor(sample.length * q)] : 0;
}

async function build(
  baseUrl: string,
  raDeg: number,
  decDeg: number,
  fov: number,
  scale: number,
  n: number,
  key: string,
  signal: AbortSignal
): Promise<Aligned> {
  const cutoutUrl = `${baseUrl}?center=${raDeg},${decDeg}&size=${(fov * 1.45).toFixed(4)}`;

  await acquire(signal);
  const t0 = Date.now();
  try {
    const buffer = await fetchBuffer(cutoutUrl, { signal, tries: 2, timeoutMs: 60000 });
    const downloadMs = Date.now() - t0;

    const hdus = parseHdus(buffer);
    const img =
      hdus.find((h) => h.header['EXTNAME'] === 'IMAGE' && h.header['NAXIS'] === '2') ||
      hdus.find((h) => h.header['NAXIS'] === '2' && h.header['BITPIX'] === '-32');
    if (!img) throw new Error('No 2D image extension found');
    if (parseInt(img.header['BITPIX'], 10) !== -32) throw new Error(`BITPIX ${img.header['BITPIX']} not supported`);

    const W = parseInt(img.header['NAXIS1'], 10);
    const H = parseInt(img.header['NAXIS2'], 10);
    const wcs = readWcs(img.header);

    const src = new Float32Array(W * H);
    for (let k = 0; k < src.length; k++) src[k] = buffer.readFloatBE(img.dataStart + k * 4);

    const toPix = makePixelMapper(wcs, raDeg * D2R, decDeg * D2R, n, scale);
    const out = new Float32Array(n * n).fill(NaN);
    let valid = 0;

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const p = toPix(i, j);
        if (!p) continue;
        const x0 = Math.floor(p[0]);
        const y0 = Math.floor(p[1]);
        if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= H - 1) continue;
        const fx = p[0] - x0;
        const fy = p[1] - y0;
        const val =
          src[y0 * W + x0] * (1 - fx) * (1 - fy) +
          src[y0 * W + x0 + 1] * fx * (1 - fy) +
          src[(y0 + 1) * W + x0] * (1 - fx) * fy +
          src[(y0 + 1) * W + x0 + 1] * fx * fy;
        if (Number.isFinite(val)) {
          out[j * n + i] = val;
          valid++;
        }
      }
      if ((j & 63) === 63) await new Promise<void>((r) => setImmediate(r));
    }

    if (valid < n * n * 0.02) {
      throw Object.assign(new Error('The cutout does not cover this region (under 2% valid pixels)'), { status: 422 });
    }

    const bg = median(out);
    for (let k = 0; k < out.length; k++) out[k] -= bg;

    const entry: Aligned = {
      buf: Buffer.from(out.buffer, out.byteOffset, out.byteLength),
      info: JSON.stringify({
        n,
        scale,
        bg: Number(bg.toFixed(4)),
        valid: Math.round((valid / (n * n)) * 100),
        downloadMs,
        totalMs: Date.now() - t0,
      }),
    };
    writeAligned(key, entry);
    return entry;
  } catch (e: any) {
    if (e?.status === 422) markNoCoverage(key);
    throw e;
  } finally {
    release();
  }
}

function toPng(buf: Buffer): Buffer {
  const vals = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const n = Math.round(Math.sqrt(vals.length));
  const lo = median(vals, 0.02);
  const range = (median(vals, 0.995) || 1) - lo || 1;

  const png = new PNG({ width: n, height: n });
  for (let k = 0; k < vals.length; k++) {
    const t = Number.isFinite(vals[k]) ? Math.min(1, Math.max(0, (vals[k] - lo) / range)) : 0;
    const c = Math.floor(Math.sqrt(t) * 255);
    png.data[k * 4] = c;
    png.data[k * 4 + 1] = c;
    png.data[k * 4 + 2] = c;
    png.data[k * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

function getPng(key: string, entry: Aligned): Buffer {
  try {
    return fs.readFileSync(pngFile(key));
  } catch {}
  const png = toPng(entry.buf);
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(pngFile(key), png);
  } catch {}
  return png;
}

function respond(key: string, entry: Aligned, format: 'png' | 'bin') {
  if (format === 'png') {
    return new NextResponse(new Uint8Array(getPng(key, entry)), {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': CACHE_CONTROL },
    });
  }
  return new NextResponse(new Uint8Array(entry.buf), {
    headers: { 'Content-Type': 'application/octet-stream', 'X-Align-Info': entry.info, 'Cache-Control': CACHE_CONTROL },
  });
}

export async function GET(request: Request) {
  const { signal } = request;
  const params = new URL(request.url).searchParams;
  const baseUrl = params.get('url') || '';
  const ra = parseFloat(params.get('ra') || '');
  const dec = parseFloat(params.get('dec') || '');
  const fov = parseFloat(params.get('fov') || '0.24');
  const scale = parseFloat(params.get('scale') || '3.075');
  const format: 'png' | 'bin' = params.get('format') === 'png' ? 'png' : 'bin';

  if (!baseUrl.startsWith('https://irsa.ipac.caltech.edu/ibe/data/spherex/')) {
    return NextResponse.json({ error: 'URL outside the SPHEREx archive' }, { status: 400 });
  }
  if (![ra, dec, fov, scale].every(Number.isFinite) || fov <= 0 || scale <= 0) {
    return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 });
  }
  if (signal.aborted) return new NextResponse(null, { status: 499 });

  const n = Math.min(1400, Math.max(16, Math.round((fov * 3600) / scale)));
  const key = `${baseUrl}|${ra}|${dec}|${fov}|${scale}`;

  if (fs.existsSync(nocovFile(key))) {
    return NextResponse.json({ error: 'No coverage in this region' }, { status: 422 });
  }

  try {
    const entry = readAligned(key) ?? (await joinJob(key, (s) => build(baseUrl, ra, dec, fov, scale, n, key, s), signal));
    return respond(key, entry, format);
  } catch (error: any) {
    if (signal.aborted) return new NextResponse(null, { status: 499 });
    console.error('[align]', error.message);
    return NextResponse.json({ error: error.message }, { status: error.status === 422 ? 422 : 502 });
  }
}