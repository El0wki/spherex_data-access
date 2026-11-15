// app/api/align/route.ts
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
  ctype: string;
};
type Aligned = { buf: Buffer; info: string };

// A chave do cache depende só de url+ra+dec+fov+scale, e a url do FITS já traz a versão do processamento.
// Se mudar o contraste do toPng(), suba PNG_VERSION (e o &v= no front) para invalidar os caches.
const PNG_VERSION = 1;
const CACHE_HDR = 'public, max-age=31536000, immutable';

// Reprojeção: calcula o mapeamento exato só a cada STEP pixels de saída e interpola entre eles
const STEP = 4;

// ---- Cache em memória, limitado por bytes (e não por número de itens) ----
const MEM_BUDGET = 96 * 1024 * 1024;
const cache = new Map<string, Aligned>();
const pngMem = new Map<string, Buffer>();
let memBytes = 0;
const NOCOV = new Set<string>(); // frames que já sabemos que não cobrem a região

function memTrim() {
  while (memBytes > MEM_BUDGET && (cache.size || pngMem.size)) {
    const m = cache.size >= pngMem.size ? cache : pngMem;
    const k = m.keys().next().value as string;
    const v = m.get(k)!;
    memBytes -= (v as any).buf ? (v as Aligned).buf.length : (v as Buffer).length;
    m.delete(k);
  }
}
const memPut = (key: string, v: Aligned) => {
  const old = cache.get(key);
  if (old) memBytes -= old.buf.length;
  cache.set(key, v);
  memBytes += v.buf.length;
  memTrim();
};
const pngPutMem = (key: string, b: Buffer) => {
  const old = pngMem.get(key);
  if (old) memBytes -= old.length;
  pngMem.set(key, b);
  memBytes += b.length;
  memTrim();
};

// Cache em disco: sobrevive a reinícios e ao hot reload do next dev
const DISK_DIR = path.join(process.cwd(), '.cache', 'align');
const diskFile = (key: string) => path.join(DISK_DIR, createHash('sha1').update(key).digest('hex') + '.bin');
const nocovFile = (key: string) => diskFile(key).replace(/\.bin$/, '.nocov');
const pngFile = (key: string) => diskFile(key).replace(/\.bin$/, `.v${PNG_VERSION}.png`);

function diskGet(key: string): Aligned | null {
  try {
    const f = fs.readFileSync(diskFile(key));
    const len = f.readUInt32BE(0);
    return { info: f.toString('utf8', 4, 4 + len), buf: f.subarray(4 + len) };
  } catch {
    return null;
  }
}

function diskPut(key: string, buf: Buffer, info: string) {
  try {
    fs.mkdirSync(DISK_DIR, { recursive: true });
    const head = Buffer.from(info, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(head.length, 0);
    fs.writeFileSync(diskFile(key), Buffer.concat([len, head, buf]));
  } catch {}
}

function markNocov(key: string) {
  NOCOV.add(key);
  try {
    fs.mkdirSync(DISK_DIR, { recursive: true });
    fs.writeFileSync(nocovFile(key), '');
  } catch {}
}
const isNocov = (key: string) => NOCOV.has(key) || fs.existsSync(nocovFile(key));

// ---- Trabalhos em andamento: várias telas pedindo o mesmo frame compartilham um só download ----
type Job = { promise: Promise<Aligned>; ctrl: AbortController; refs: number };
const inflight = new Map<string, Job>();

function joinJob(key: string, make: (signal: AbortSignal) => Promise<Aligned>, signal: AbortSignal): Promise<Aligned> {
  let job = inflight.get(key);
  if (!job) {
    const ctrl = new AbortController();
    const promise = make(ctrl.signal).finally(() => inflight.delete(key));
    job = { promise, ctrl, refs: 0 };
    inflight.set(key, job);
  }
  const j = job;
  j.refs++;
  // só cancela o download se TODOS que pediram desistiram
  const onAbort = () => {
    j.refs--;
    if (j.refs <= 0) j.ctrl.abort();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return j.promise.finally(() => signal.removeEventListener('abort', onAbort));
}

// ---- Parser de FITS (MEF) ----
function parseHdus(buf: Buffer): Hdu[] {
  const hdus: Hdu[] = [];
  let offset = 0;
  while (offset + 2880 <= buf.length) {
    const header: Record<string, string> = {};
    let ended = false;
    while (!ended && offset + 2880 <= buf.length) {
      for (let i = 0; i < 36; i++) {
        const card = buf.toString('ascii', offset + i * 80, offset + (i + 1) * 80);
        const key = card.slice(0, 8).trim();
        if (key === 'END') { ended = true; break; }
        if (card[8] === '=') {
          header[key] = card.slice(10).split('/')[0].trim().replace(/^'|'$/g, '').trim();
        }
      }
      offset += 2880;
    }
    if (!ended) break;

    const bitpix = Math.abs(parseInt(header['BITPIX'] || '8', 10)) / 8;
    const naxis = parseInt(header['NAXIS'] || '0', 10);
    let prod = naxis > 0 ? 1 : 0;
    for (let n = 1; n <= naxis; n++) prod *= parseInt(header[`NAXIS${n}`] || '0', 10);
    const pcount = parseInt(header['PCOUNT'] || '0', 10);
    const gcount = parseInt(header['GCOUNT'] || '1', 10);
    const dataBytes = bitpix * gcount * (pcount + prod);

    hdus.push({ header, dataStart: offset });
    offset += Math.ceil(dataBytes / 2880) * 2880;
  }
  return hdus;
}

// ---- WCS (TAN + SIP opcional) ----
const num = (h: Record<string, string>, k: string, d = NaN) => {
  const s = h[k];
  if (s === undefined) return d;
  const v = parseFloat(s.replace(/[dD]/, 'E'));
  return Number.isFinite(v) ? v : d;
};

function readSip(h: Record<string, string>, p: 'A' | 'B'): Sip {
  const order = num(h, `${p}_ORDER`, 0);
  const out: Sip = [];
  for (let a = 0; a <= order; a++) {
    for (let b = 0; a + b <= order; b++) {
      if (a + b < 2) continue;
      const c = num(h, `${p}_${a}_${b}`, 0);
      if (c !== 0) out.push([a, b, c]);
    }
  }
  return out;
}

function readWcs(h: Record<string, string>): Wcs {
  const ctype = h['CTYPE1'] || '';
  if (!ctype.includes('TAN')) throw new Error(`Projeção WCS não suportada: "${ctype || 'sem CTYPE1'}"`);

  const crval: [number, number] = [num(h, 'CRVAL1'), num(h, 'CRVAL2')];
  const crpix: [number, number] = [num(h, 'CRPIX1'), num(h, 'CRPIX2')];
  if (!Number.isFinite(crval[0]) || !Number.isFinite(crpix[0])) throw new Error('Header sem CRVAL/CRPIX');

  let cd: [[number, number], [number, number]];
  if (Number.isFinite(num(h, 'CD1_1'))) {
    cd = [
      [num(h, 'CD1_1'), num(h, 'CD1_2', 0)],
      [num(h, 'CD2_1', 0), num(h, 'CD2_2')],
    ];
  } else {
    const d1 = num(h, 'CDELT1');
    const d2 = num(h, 'CDELT2');
    if (!Number.isFinite(d1) || !Number.isFinite(d2)) throw new Error('Header sem CD nem CDELT');
    cd = [
      [d1 * num(h, 'PC1_1', 1), d1 * num(h, 'PC1_2', 0)],
      [d2 * num(h, 'PC2_1', 0), d2 * num(h, 'PC2_2', 1)],
    ];
  }
  const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
  if (!det) throw new Error('Matriz CD singular');
  const inv: [[number, number], [number, number]] = [
    [cd[1][1] / det, -cd[0][1] / det],
    [-cd[1][0] / det, cd[0][0] / det],
  ];
  return { crval, crpix, inv, sipA: readSip(h, 'A'), sipB: readSip(h, 'B'), ctype };
}

const sipEval = (c: Sip, u: number, v: number) => {
  let s = 0;
  for (const [a, b, k] of c) s += k * Math.pow(u, a) * Math.pow(v, b);
  return s;
};

// céu (graus) -> pixel (base 0) da imagem de entrada
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

// Mapa (i,j) da grade de saída -> pixel de entrada.
// O cálculo exato (trigonometria + iteração do SIP) roda só nos nós de uma grade grossa (a cada STEP pixels);
// no meio, interpola bilinear. Onde algum nó falha, cai no cálculo exato.
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
    if (ok[a] && ok[b] && ok[c] && ok[d]) {
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
    }
    return exact(i, j);
  };
}

// Campos de header que provavelmente dizem quando/como/em que cor o frame foi observado.
// Nomes não confirmados: pega o que casar e o /api/inspect mostra o resto.
const META_RE = /^(DATE|MJD|EXPT|EXPO|DETECT|OBSID|BAND|WAVE|LAMBDA|LAM)/i;
function pickMeta(...headers: Record<string, string>[]) {
  const meta: Record<string, string> = {};
  for (const h of headers) {
    for (const k of Object.keys(h)) {
      if (Object.keys(meta).length >= 24) return meta;
      if (META_RE.test(k) && !(k in meta)) meta[k] = h[k].replace(/[^\x20-\x7E]/g, '').slice(0, 40);
    }
  }
  return meta;
}

// ---- Baixa o recorte, alinha ao céu (norte em cima) e guarda nos caches ----
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
  const t0 = Date.now();
  // O quadrado de saída (norte em cima) pode ficar girado em relação ao detector: recorte maior evita cantos vazios
  const cutoutUrl = `${baseUrl}?center=${raDeg},${decDeg}&size=${(fov * 1.45).toFixed(4)}`;

  await acquire(signal); // lança AbortError se cancelado na fila
  const tStart = Date.now(); // daqui em diante não conta mais o tempo de espera na fila
  try {
    const buffer = await fetchBuffer(cutoutUrl, { signal, tries: 2, timeoutMs: 60000 });
    const tDown = Date.now() - tStart;

    const hdus = parseHdus(buffer);
    const img =
      hdus.find((h) => h.header['EXTNAME'] === 'IMAGE' && h.header['NAXIS'] === '2') ||
      hdus.find((h) => h.header['NAXIS'] === '2' && h.header['BITPIX'] === '-32');
    if (!img) throw new Error('Nenhuma extensão de imagem 2D encontrada');
    if (parseInt(img.header['BITPIX'], 10) !== -32) throw new Error(`BITPIX ${img.header['BITPIX']} não suportado`);

    const W = parseInt(img.header['NAXIS1'], 10);
    const H = parseInt(img.header['NAXIS2'], 10);
    const wcs = readWcs(img.header);

    const src = new Float32Array(W * H);
    for (let k = 0; k < src.length; k++) src[k] = buffer.readFloatBE(img.dataStart + k * 4);

    // Reprojeção: para cada pixel da grade de saída, acha o pixel de entrada (interpolação bilinear)
    const toPix = makePixelMapper(wcs, raDeg * D2R, decDeg * D2R, n, scale);
    const out = new Float32Array(n * n).fill(NaN);
    let valid = 0;

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const p = toPix(i, j);
        if (!p) continue;
        const [px, py] = p;
        const x0 = Math.floor(px);
        const y0 = Math.floor(py);
        if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= H - 1) continue;
        const fx = px - x0;
        const fy = py - y0;
        const a = src[y0 * W + x0];
        const b = src[y0 * W + x0 + 1];
        const c = src[(y0 + 1) * W + x0];
        const d = src[(y0 + 1) * W + x0 + 1];
        const val = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
        if (Number.isFinite(val)) {
          out[j * n + i] = val;
          valid++;
        }
      }
      // devolve o controle ao event loop de vez em quando, para não travar outras requisições
      if ((j & 63) === 63) await new Promise<void>((r) => setImmediate(r));
    }

    if (valid < n * n * 0.02) {
      const err: any = new Error('O recorte não cobre essa região (menos de 2% de pixels válidos)');
      err.status = 422;
      throw err;
    }

    // Tira o fundo (mediana) de cada frame: o brilho zodiacal muda de uma observação para outra
    const sample: number[] = [];
    const stride = Math.max(1, Math.floor(out.length / 20000));
    for (let k = 0; k < out.length; k += stride) if (Number.isFinite(out[k])) sample.push(out[k]);
    sample.sort((a, b) => a - b);
    const bg = sample.length ? sample[Math.floor(sample.length / 2)] : 0;
    for (let k = 0; k < out.length; k++) out[k] -= bg;

    const info = JSON.stringify({
      n,
      scale,
      bg: Number(bg.toFixed(4)),
      valid: Math.round((valid / (n * n)) * 100),
      ctype: wcs.ctype,
      sip: wcs.sipA.length > 0 || wcs.sipB.length > 0,
      src: `${W}x${H}`,
      hdus: hdus.map((h) => h.header['EXTNAME'] || h.header['XTENSION'] || 'PRIMARY'),
      meta: pickMeta(img.header, hdus[0]?.header || {}),
      downloadMs: tDown,
      queueMs: tStart - t0,
      totalMs: Date.now() - t0,
    });

    const entry: Aligned = { buf: Buffer.from(out.buffer, out.byteOffset, out.byteLength), info };
    memPut(key, entry);
    diskPut(key, entry.buf, info);
    return entry;
  } catch (e: any) {
    if (e?.status === 422) markNocov(key); // não baixa de novo só para descobrir que não cobre
    throw e;
  } finally {
    release();
  }
}

// ---- Dado alinhado -> PNG em tons de cinza (miniaturas e frame individual do mapa) ----
function toPng(buf: Buffer): Buffer {
  // cópia para garantir alinhamento de 4 bytes (o buffer do disco pode vir deslocado)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const vals = new Float32Array(ab);
  const n = Math.round(Math.sqrt(vals.length));

  const sample: number[] = [];
  const stride = Math.max(1, Math.floor(vals.length / 20000));
  for (let k = 0; k < vals.length; k += stride) if (Number.isFinite(vals[k])) sample.push(vals[k]);
  sample.sort((a, b) => a - b);
  const lo = sample.length ? sample[Math.floor(sample.length * 0.02)] : 0;
  const hi = sample.length ? sample[Math.floor(sample.length * 0.995)] : 1;
  const range = hi - lo || 1;

  const png = new PNG({ width: n, height: n });
  for (let k = 0; k < vals.length; k++) {
    const v = vals[k];
    const t = Number.isFinite(v) ? Math.min(1, Math.max(0, (v - lo) / range)) : 0;
    const c = Math.floor(Math.sqrt(t) * 255);
    const idx = k * 4;
    png.data[idx] = c;
    png.data[idx + 1] = c;
    png.data[idx + 2] = c;
    png.data[idx + 3] = 255;
  }
  return PNG.sync.write(png);
}

// PNG com cache (memória + disco): requisições repetidas não recodificam
function getPng(key: string, entry: Aligned): Buffer {
  const m = pngMem.get(key);
  if (m) return m;
  try {
    const d = fs.readFileSync(pngFile(key));
    pngPutMem(key, d);
    return d;
  } catch {}
  const b = toPng(entry.buf);
  pngPutMem(key, b);
  try {
    fs.mkdirSync(DISK_DIR, { recursive: true });
    fs.writeFileSync(pngFile(key), b);
  } catch {}
  return b;
}

function respond(key: string, entry: Aligned, format: 'png' | 'bin') {
  if (format === 'png') {
    return new NextResponse(new Uint8Array(getPng(key, entry)), {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': CACHE_HDR },
    });
  }
  return new NextResponse(new Uint8Array(entry.buf), {
    headers: { 'Content-Type': 'application/octet-stream', 'X-Align-Info': entry.info, 'Cache-Control': CACHE_HDR },
  });
}

export async function GET(request: Request) {
  const signal = request.signal;
  const { searchParams } = new URL(request.url);
  const baseUrl = searchParams.get('url') || '';
  const raDeg = parseFloat(searchParams.get('ra') || '');
  const decDeg = parseFloat(searchParams.get('dec') || '');
  const fov = parseFloat(searchParams.get('fov') || '0.24');
  const scale = parseFloat(searchParams.get('scale') || '3.075'); // arcsec/pixel da grade de saída
  const format: 'png' | 'bin' = searchParams.get('format') === 'png' ? 'png' : 'bin';

  if (!baseUrl.startsWith('https://irsa.ipac.caltech.edu/ibe/data/spherex/')) {
    return NextResponse.json({ error: 'URL fora do arquivo SPHEREx' }, { status: 400 });
  }
  if (![raDeg, decDeg, fov, scale].every(Number.isFinite) || fov <= 0 || scale <= 0) {
    return NextResponse.json({ error: 'Parâmetros inválidos' }, { status: 400 });
  }
  if (signal.aborted) return new NextResponse(null, { status: 499 });

  const n = Math.min(1400, Math.max(16, Math.round((fov * 3600) / scale)));
  // A chave não inclui o formato: o PNG e o binário saem do mesmo dado e do mesmo download
  const key = `${baseUrl}|${raDeg}|${decDeg}|${fov}|${scale}`;

  if (isNocov(key)) {
    return NextResponse.json({ error: 'Sem cobertura nessa região' }, { status: 422 });
  }

  let entry = cache.get(key);
  if (!entry) {
    const d = diskGet(key);
    if (d) {
      memPut(key, d);
      entry = d;
    }
  }
  if (entry) return respond(key, entry, format);

  try {
    entry = await joinJob(key, (s) => build(baseUrl, raDeg, decDeg, fov, scale, n, key, s), signal);
    return respond(key, entry, format);
  } catch (error: any) {
    if (signal.aborted) return new NextResponse(null, { status: 499 });
    console.error('[align]', error.message);
    return NextResponse.json({ error: error.message }, { status: error.status === 422 ? 422 : 502 });
  }
}