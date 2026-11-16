import { NextResponse } from 'next/server';
import { acquire, release, fetchBuffer } from '../../../lib/irsa';

function parseHdus(buf: Buffer) {
  const hdus: { extname: string; dims: number[]; header: Record<string, string> }[] = [];
  let offset = 0;
  while (offset + 2880 <= buf.length) {
    const header: Record<string, string> = {};
    let ended = false;
    while (!ended && offset + 2880 <= buf.length) {
      for (let i = 0; i < 36 && !ended; i++) {
        const card = buf.toString('ascii', offset + i * 80, offset + (i + 1) * 80);
        const key = card.slice(0, 8).trim();
        if (key === 'END') ended = true;
        else if (card[8] === '=') header[key] = card.slice(10).trim();
      }
      offset += 2880;
    }
    if (!ended) break;

    const clean = (k: string) => (header[k] || '').split('/')[0].replace(/'/g, '').trim();
    const int = (k: string, d: number) => {
      const v = parseInt(clean(k), 10);
      return Number.isNaN(v) ? d : v;
    };
    const dims = Array.from({ length: int('NAXIS', 0) }, (_, i) => int(`NAXIS${i + 1}`, 0));
    const size = dims.length ? dims.reduce((a, b) => a * b, 1) : 0;
    const dataBytes = (Math.abs(int('BITPIX', 8)) / 8) * int('GCOUNT', 1) * (int('PCOUNT', 0) + size);

    hdus.push({ extname: clean('EXTNAME') || (hdus.length ? '(unnamed)' : 'PRIMARY'), dims, header });
    offset += Math.ceil(dataBytes / 2880) * 2880;
  }
  return hdus;
}

export async function GET(request: Request) {
  const { signal } = request;
  const params = new URL(request.url).searchParams;
  const base = params.get('url') || '';
  const ra = params.get('ra');
  const dec = params.get('dec');
  const size = params.get('size') || '0.24';

  if (!base.startsWith('https://irsa.ipac.caltech.edu/ibe/data/spherex/')) {
    return NextResponse.json({ error: 'URL outside the SPHEREx archive' }, { status: 400 });
  }
  if (!ra || !dec) {
    return NextResponse.json({ error: 'Pass ra and dec (and optionally size) to download only the cutout' }, { status: 400 });
  }
  const url = `${base}?center=${ra},${dec}&size=${size}`;

  try {
    await acquire(signal);
  } catch {
    return new NextResponse(null, { status: 499 });
  }
  try {
    const buf = await fetchBuffer(url, { signal, tries: 2, timeoutMs: 60000 });
    return new NextResponse(JSON.stringify({ url, bytes: buf.length, hdus: parseHdus(buf) }, null, 2), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  } catch (e: any) {
    if (signal.aborted) return new NextResponse(null, { status: 499 });
    return NextResponse.json({ error: e.message }, { status: 502 });
  } finally {
    release();
  }
}