// 엑셀(.xlsx)과 CSV를 읽는 작은 도구. 외부 라이브러리 없이 브라우저(와 Node)에서 동작합니다.
// 돌려주는 값: { sheets: [{ name, rows: [[셀, ...], ...] }] }  (셀은 모두 문자열, 날짜는 YYYY-MM-DD, 시간은 HH:MM)

const td = new TextDecoder('utf-8');

async function inflateRaw(u8) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter(); w.write(u8); w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

function openZip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let e = u8.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('엑셀(.xlsx) 파일이 아닙니다.');
  const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
  const files = {};
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
    files[td.decode(u8.subarray(p + 46, p + 46 + nl))] = { method, csize, lho };
    p += 46 + nl + el + cl;
  }
  return {
    has: name => !!files[name],
    names: () => Object.keys(files),
    async read(name) {
      const f = files[name]; if (!f) return null;
      const nl = dv.getUint16(f.lho + 26, true), el = dv.getUint16(f.lho + 28, true);
      const start = f.lho + 30 + nl + el, data = u8.subarray(start, start + f.csize);
      const raw = f.method === 0 ? data : await inflateRaw(data);
      return td.decode(raw);
    }
  };
}

const ent = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
const attr = (s, k) => { const m = new RegExp('\\b' + k + '="([^"]*)"').exec(s); return m ? ent(m[1]) : null; };
const textOf = xml => { let out = ''; const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g; let m; while ((m = re.exec(xml))) out += ent(m[1]); return out; };

const colIndex = ref => { let n = 0; const l = /^[A-Z]+/.exec(ref)[0]; for (const ch of l) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function serialToStr(v, withDate, withTime) {
  const days = Math.floor(v), frac = v - days;
  let out = '';
  if (withDate && days >= 1) out = new Date(Date.UTC(1899, 11, 30) + days * 86400000).toISOString().slice(0, 10);
  if (withTime && (frac > 0 || !withDate)) {
    const mins = Math.round(frac * 1440), h = Math.floor(mins / 60) % 24, m = mins % 60;
    const t = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    out = out ? (frac > 0 ? out + ' ' + t : out) : t;
  }
  return out;
}

export async function readXlsx(buf) {
  const zip = openZip(buf);
  if (!zip.has('xl/workbook.xml')) throw new Error('엑셀(.xlsx) 파일이 아닙니다.');
  const wb = await zip.read('xl/workbook.xml');
  const rels = (await zip.read('xl/_rels/workbook.xml.rels')) || '';
  const relMap = {}; { const re = /<Relationship\b([^>]*)\/?>/g; let m; while ((m = re.exec(rels))) relMap[attr(m[1], 'Id')] = attr(m[1], 'Target'); }
  let shared = [];
  const ssx = await zip.read('xl/sharedStrings.xml');
  if (ssx) { const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g; let m; while ((m = re.exec(ssx))) shared.push(textOf(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, ''))); }
  // 날짜 서식
  const dateXf = [];
  const stx = await zip.read('xl/styles.xml');
  if (stx) {
    const custom = {}; { const re = /<numFmt\b([^>]*)\/>/g; let m; while ((m = re.exec(stx))) custom[attr(m[1], 'numFmtId')] = attr(m[1], 'formatCode') || ''; }
    const cx = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stx);
    if (cx) { const re = /<xf\b([^>]*?)\/?>/g; let m; while ((m = re.exec(cx[1]))) {
      const id = attr(m[1], 'numFmtId'), code = custom[id];
      let kind = null;
      if (code != null) { const c = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, ''); const d = /[ymd]/i.test(c), t = /[hs]/i.test(c) || /AM\/PM/i.test(c); if (d || t) kind = { d, t }; }
      else if (BUILTIN_DATE.has(+id)) kind = { d: !(+id >= 18 && +id <= 21) && !(+id >= 45 && +id <= 47), t: (+id >= 18 && +id <= 22) || (+id >= 45 && +id <= 47) };
      dateXf.push(kind);
    } }
  }
  const sheets = [];
  const re = /<sheet\b([^>]*)\/?>/g; let sm;
  while ((sm = re.exec(wb))) {
    const name = attr(sm[1], 'name'), rid = attr(sm[1], 'r:id') || attr(sm[1], 'id');
    let target = relMap[rid]; if (!target) continue;
    target = target.replace(/^\//, ''); if (!target.startsWith('xl/')) target = 'xl/' + target;
    const xml = await zip.read(target); if (!xml) continue;
    const rows = []; let maxc = 0;
    const cre = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let cm;
    while ((cm = cre.exec(xml))) {
      const at = cm[1], inner = cm[2] || '', ref = attr(at, 'r'); if (!ref) continue;
      const c = colIndex(ref), r = parseInt(/\d+/.exec(ref)[0], 10) - 1, t = attr(at, 't'), s = attr(at, 's');
      let val = '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      if (t === 's') val = v ? (shared[+v[1]] ?? '') : '';
      else if (t === 'inlineStr') val = textOf(inner);
      else if (t === 'b') val = v && v[1] === '1' ? 'TRUE' : 'FALSE';
      else if (t === 'str' || t === 'e') val = v ? ent(v[1]) : '';
      else if (v) {
        const num = parseFloat(v[1]); const k = s != null ? dateXf[+s] : null;
        val = (k && isFinite(num) && num >= 0 && num < 2958466) ? serialToStr(num, k.d, k.t) : (isFinite(num) ? String(Number.isInteger(num) ? num : +num.toFixed(10)) : v[1]);
      }
      (rows[r] = rows[r] || [])[c] = val; if (c + 1 > maxc) maxc = c + 1;
    }
    // 병합된 셀은 왼쪽 위 값을 병합 범위 전체에 채웁니다.
    const mre = /<mergeCell\b([^>]*)\/>/g; let mm;
    while ((mm = mre.exec(xml))) {
      const ref = attr(mm[1], 'ref'); if (!ref || ref.indexOf(':') < 0) continue;
      const [a, b] = ref.split(':'); const r0 = parseInt(/\d+/.exec(a)[0], 10) - 1, c0 = colIndex(a), r1 = parseInt(/\d+/.exec(b)[0], 10) - 1, c1 = colIndex(b);
      const val = (rows[r0] && rows[r0][c0]) || '';
      for (let r = r0; r <= r1 && r < r0 + 200; r++) for (let c = c0; c <= c1; c++) { (rows[r] = rows[r] || [])[c] = val; if (c + 1 > maxc) maxc = c + 1; }
    }
    const dense = []; for (let r = 0; r < rows.length; r++) { const row = rows[r] || []; const out = []; for (let c = 0; c < maxc; c++) out.push(row[c] == null ? '' : String(row[c]).trim()); dense.push(out); }
    sheets.push({ name, rows: dense });
  }
  return { sheets };
}

export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = first.indexOf('\t') >= 0 ? '\t' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return { sheets: [{ name: 'CSV', rows: rows.map(r => r.map(x => x.trim())) }] };
}

// 파일(File 또는 ArrayBuffer + 이름)을 읽어 표로 바꿉니다. 사진/PDF는 kind 로 알려줍니다.
export async function readTableFile(name, buf) {
  const lower = (name || '').toLowerCase();
  if (/\.(png|jpe?g|heic|gif|webp)$/.test(lower)) return { kind: 'image' };
  if (/\.pdf$/.test(lower)) return { kind: 'pdf' };
  if (/\.xls$/.test(lower)) return { kind: 'xls' };
  if (/\.(xlsx|xlsm)$/.test(lower)) return Object.assign({ kind: 'table' }, await readXlsx(buf));
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { text = new TextDecoder('euc-kr').decode(buf); }
  return Object.assign({ kind: 'table' }, parseCsv(text));
}
