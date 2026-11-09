// 수납장부/신청내역 엑셀 → 수강생 목록, 시간표 엑셀·붙여넣기 → 수업 목록으로 바꾸는 계산 모음 (화면과 무관한 순수 함수)
import { DOW, DOW_ORDER, newId, parseDate, addDays, shiftMonth, memberKey, defaultCap, minutesBetween } from "./schedule.js";

const norm = s => String(s == null ? '' : s).normalize('NFC').replace(/\s+/g, ' ').trim();
const nkey = s => norm(s).toLowerCase().replace(/\s+/g, '');
const lastDay = ym => addDays(shiftMonth(ym, 1) + '-01', -1);
const pad = n => String(n).padStart(2, '0');
// 시작일에서 n개월 뒤 같은 날의 전날 (예: 11-08 + 1개월 → 12-07)
function monthsLater(date, n) {
  const ym = shiftMonth(date.slice(0, 7), n), dim = +lastDay(ym).slice(8);
  return addDays(ym + '-' + pad(Math.min(+date.slice(8), dim)), -1);
}

/* ---------- 날짜/시간 읽기 ---------- */
export function normDateStr(v) {
  const s = norm(v); if (!s) return '';
  let m = /(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})/.exec(s);
  if (!m) m = /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일?/.exec(s);
  if (!m) return '';
  const d = m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);
  const t = parseDate(d); return (t.getUTCFullYear() == +m[1] && t.getUTCMonth() + 1 == +m[2] && t.getUTCDate() == +m[3]) ? d : '';
}
export function normTime(h, m) { return pad(+h) + ':' + pad(+(m || 0)); }
export function parseTimeRange(s) {
  s = String(s || '');
  const m = /(\d{1,2})\s*[:시]\s*(\d{2})?\s*분?\s*[-~–—]\s*(\d{1,2})\s*[:시]?\s*(\d{2})?/.exec(s);
  if (!m) return null;
  const a = normTime(m[1], m[2]), b = normTime(m[3], m[4]);
  return (a < b && +m[1] < 24 && +m[3] < 24) ? { start: a, end: b, text: m[0] } : null;
}
export function parseDays(s) {
  s = String(s || '').replace(/요일/g, '');
  const out = new Set();
  if (/매일/.test(s)) [0, 1, 2, 3, 4, 5, 6].forEach(d => out.add(d));
  if (/평일/.test(s)) [1, 2, 3, 4, 5].forEach(d => out.add(d));
  if (/주말/.test(s)) [0, 6].forEach(d => out.add(d));
  for (const ch of s) { const i = DOW.indexOf(ch); if (i >= 0) out.add(i); }
  return DOW_ORDER.filter(d => out.has(d));
}

/* ---------- 열 이름 찾기 ---------- */
function findHeader(rows, roles, maxScan = 12) {
  let best = null;
  for (let r = 0; r < Math.min(rows.length, maxScan); r++) {
    const cols = {}; let hits = 0;
    rows[r].forEach((cell, c) => {
      const t = nkey(cell); if (!t) return;
      for (const role in roles) { if (cols[role] == null && roles[role](t)) { cols[role] = c; hits++; break; } }
    });
    if (!best || hits > best.hits) best = { row: r, cols, hits };
  }
  return best;
}

/* ---------- 수강권 횟수 짐작 ---------- */
// 요일&시간자유(자유이용권)는 월 8회, 주2회반(월수·화목)은 월 8회, 주1회반(금·토 등)은 월 4회, 절반권은 4회.
export function productInfo(product) {
  const p = norm(product); if (!p) return {};
  const lab = /\[\s*(\d{2})\s*[.\-]\s*(\d{1,2})\s*月?\s*\]/.exec(p) || /\[\s*(\d{2})\s*[.\-]\s*(\d{1,2})\s*월\s*\]/.exec(p);
  const mm = /(\d+)\s*개월/.exec(p);
  const months = mm ? Math.max(1, +mm[1]) : 1;
  let perMonth = null;
  if (/절반/.test(p)) perMonth = 4;
  else if (/요일\s*[&,·\s]*\s*시간\s*자유|시간\s*자유|요일\s*자유|자유이용/.test(p)) perMonth = 8;
  else if (/주\s*(\d)\s*회/.test(p)) perMonth = 4 * +/주\s*(\d)\s*회/.exec(p)[1];
  else if (/월수|화목|월\s*수|화\s*목/.test(p)) perMonth = 8;
  else if (/[-–]\s*[월화수목금토일]/.test(p)) perMonth = 4;
  return { year: lab ? 2000 + +lab[1] : null, month: lab ? +lab[2] : null, months, perMonth, credits: perMonth != null ? perMonth * months : null };
}

/* ---------- 수납장부 / 신청내역 → 수강생 ---------- */
const LEDGER_ROLES = {
  name: t => /^(이름|학생|성명|수강생|회원|학생명|수강생명|회원명)$/.test(t),
  phone: t => /(전화|연락처|휴대|핸드폰|폰번|뒤4|뒷4|뒤네|last4)/.test(t),
  product: t => /(강의|상품|수강권|과정|분반|반명|수업)/.test(t),
  start: t => /(시작|개시)/.test(t),
  end: t => /(종료|만료|끝)/.test(t),
  credits: t => /(횟수|회차|크레딧|회수|^회$)/.test(t),
  paid: t => /(결제일|납부일|등록일|수납일|결제일시|등록일시|입금일)/.test(t),
  status: t => /^(상태|결제상태|진행상태)$/.test(t)
};

export function parseLedger(rows) {
  const h = findHeader(rows, LEDGER_ROLES);
  if (!h || h.cols.name == null || (h.cols.product == null && h.cols.credits == null && h.cols.start == null)) {
    return { error: '열 이름을 찾지 못했어요. 첫 줄에 "이름(또는 학생)", "강의/상품", "시작", "종료", "횟수", "전화번호" 같은 제목이 있는지 확인해주세요.', entries: [], skipped: [] };
  }
  const c = h.cols, entries = [], skipped = [];
  const byKey = new Map();
  for (let r = h.row + 1; r < rows.length; r++) {
    const row = rows[r]; const name = norm(row[c.name]); if (!name) continue;
    const get = k => (c[k] == null ? '' : norm(row[c[k]]));
    const status = get('status');
    if (status && /(취소|환불|대기|미결제|실패)/.test(status)) { skipped.push(name + ' (' + status + ')'); continue; }
    const digits = get('phone').replace(/\D/g, ''); const last4 = digits.length >= 4 ? digits.slice(-4) : '';
    const product = get('product'), info = productInfo(product);
    let start = normDateStr(get('start')), end = normDateStr(get('end'));
    const paid = normDateStr(get('paid'));
    if (!start && info.month) start = info.year + '-' + pad(info.month) + '-01';
    if (!start && paid) start = paid;
    if (!end && start) end = (info.month && start.slice(8) === '01') ? lastDay(shiftMonth(start.slice(0, 7), info.months - 1)) : monthsLater(start, info.months || 1);
    let credits = c.credits != null && /^\d+$/.test(get('credits')) ? +get('credits') : (info.credits != null ? info.credits : null);
    const key = (last4 ? name + '|' + last4 : name);
    const note = product;
    if (byKey.has(key)) {
      const e = byKey.get(key);
      if (start && (!e.start || start < e.start)) e.start = start;
      if (end && (!e.end || end > e.end)) e.end = end;
      if (credits == null) e.unknownCredit = true; else e.credits = (e.credits || 0) + credits;
      if (note) e.notes.push(note);
    } else {
      const e = { name, last4, start, end, credits, notes: note ? [note] : [], unknownCredit: credits == null };
      byKey.set(key, e); entries.push(e);
    }
  }
  return { entries, skipped, error: '' };
}

// 읽어온 항목을 지금 등록된 수강생과 맞춰보고, 기본 처리 방법을 정합니다.
export async function planMembers(entries, members) {
  const byId = new Map(members.map(m => [m.id, m]));
  const byName = new Map(); members.forEach(m => { const k = nkey(m.name); (byName.get(k) || byName.set(k, []).get(k)).push(m); });
  const out = [];
  for (const e of entries) {
    const item = Object.assign({}, e, { existing: null, issue: '', action: 'create' });
    let last4 = e.last4;
    if (!last4) {
      const cands = byName.get(nkey(e.name)) || [];
      if (cands.length === 1) { last4 = cands[0].last4; item.last4 = last4; item.matchedByName = true; }
      else item.issue = cands.length > 1 ? '같은 이름이 여러 명이라 전화번호 뒤 4자리가 필요해요' : '전화번호 뒤 4자리가 필요해요';
    }
    if (last4) {
      item.id = await memberKey(e.name, last4);
      item.existing = byId.get(item.id) || null;
    }
    if (!item.start || !item.end) item.issue = item.issue || '수강 기간(시작·종료)을 확인해주세요';
    if (item.credits == null) item.issue = item.issue || '횟수를 입력해주세요';
    if (item.unknownCredit && item.credits != null) item.warn = '횟수를 알 수 없는 상품이 섞여 있어 확인이 필요해요';
    const ex = item.existing;
    if (!ex) item.action = 'create';
    else if (ex.start === item.start && ex.end === item.end && ex.total === item.credits) item.action = 'skip';
    else if (item.start > ex.end) item.action = 'replace';
    else item.action = 'adjust';
    out.push(item);
  }
  return out;
}

// 처리 방법별로 실제 저장할 값. increment 값은 학생이 동시에 예약해도 안전하게 더하고 뺍니다.
export function memberWrite(item) {
  const ex = item.existing;
  if (item.action === 'create') return { op: 'set', data: { name: item.name, last4: item.last4, start: item.start, end: item.end, credits: item.credits, total: item.credits, lastRef: '' } };
  if (!ex) return null;
  if (item.action === 'replace') return { op: 'update', data: { start: item.start, end: item.end, credits: item.credits, total: item.credits } };
  if (item.action === 'adjust') {            // 사용한 횟수는 유지하고 총 횟수만 맞춤
    let delta = item.credits - (ex.total || 0);
    if ((ex.credits || 0) + delta < 0) delta = -(ex.credits || 0);
    return { op: 'update', data: { start: item.start, end: item.end }, inc: { credits: delta, total: item.credits - (ex.total || 0) } };
  }
  if (item.action === 'add') {
    return { op: 'update', data: { end: item.end > ex.end ? item.end : ex.end }, inc: { credits: item.credits, total: item.credits } };
  }
  return null;
}

/* ---------- 시간표 읽기 ---------- */
const SCHED_ROLES = {
  name: t => /^(수업|수업명|강의|강의명|반|반명|과목|클래스|수업이름)$/.test(t) || /^(강의-?분반명)$/.test(t),
  days: t => /^(요일|수업요일|day)$/.test(t),
  time: t => /^(시간|수업시간|시간대|time)$/.test(t),
  start: t => /^(시작|시작시간|시작시각)$/.test(t),
  end: t => /^(끝|종료|종료시간|끝시간|종료시각)$/.test(t),
  teacher: t => /^(센세|선생|선생님|강사|담당|담당센세|담당강사|교사|teacher)$/.test(t),
  cap: t => /^(정원|인원|최대인원)$/.test(t)
};

const cleanName = s => norm(s).replace(/^\[[^\]]*\]\s*/, '');

export function teacherMatcher(teachers) {
  const ids = Object.keys(teachers || {});
  const strip = s => nkey(s).replace(/(센세|선생님|선생|쌤|sensei)$/g, '');
  return text => {
    const t = strip(text); if (!t) return null;
    for (const id of ids) {
      const names = [teachers[id].name].concat(teachers[id].aliases || []);
      if (names.some(n => strip(n) === t)) return id;
    }
    for (const id of ids) {
      const names = [teachers[id].name].concat(teachers[id].aliases || []);
      if (names.some(n => { const s = strip(n); return s.length >= 2 && (t.includes(s) || s.includes(t)); })) return id;
    }
    return null;
  };
}

function listLayout(rows, h) {
  const c = h.cols, out = [], errs = [];
  for (let r = h.row + 1; r < rows.length; r++) {
    const row = rows[r]; const get = k => (c[k] == null ? '' : norm(row[c[k]]));
    const name = cleanName(get('name')); if (!name && !get('days') && !get('time')) continue;
    let tr = c.time != null ? parseTimeRange(get('time')) : null;
    if (!tr && c.start != null && c.end != null) { const a = /(\d{1,2})\s*:\s*(\d{2})/.exec(get('start')), b = /(\d{1,2})\s*:\s*(\d{2})/.exec(get('end')); if (a && b) tr = { start: normTime(a[1], a[2]), end: normTime(b[1], b[2]) }; }
    const days = parseDays(get('days'));
    if (!name || !tr || !days.length) { errs.push((r + 1) + '번째 줄: 수업명·요일·시간을 읽지 못했어요 (' + row.filter(Boolean).join(' / ').slice(0, 40) + ')'); continue; }
    out.push({ name, days, start: tr.start, end: tr.end, teacherText: get('teacher'), cap: /^\d+$/.test(get('cap')) ? +get('cap') : null });
  }
  return { slots: out, errs };
}

function gridLayout(rows, teachers) {
  // 요일이 가로로 놓인 표: 첫 줄(또는 위쪽 줄) 에 월~일 중 3개 이상
  let hr = -1, dayCols = {};
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const cols = {}; rows[r].forEach((cell, c) => { const t = norm(cell).replace(/요일/g, ''); if (/^[월화수목금토일]$/.test(t)) cols[c] = DOW.indexOf(t); });
    if (Object.keys(cols).length >= 3) { hr = r; dayCols = cols; break; }
  }
  if (hr < 0) return null;
  const match = teacherMatcher(teachers), out = [], errs = [];
  for (let r = hr + 1; r < rows.length; r++) {
    const rowLabel = rows[r].filter((_, c) => !(c in dayCols)).join(' ');
    const rowTime = parseTimeRange(rowLabel);
    Object.keys(dayCols).forEach(cs => {
      const c = +cs, cell = norm(rows[r][c]); if (!cell) return;
      const lines = String(rows[r][c]).split(/\n/).map(norm).filter(Boolean);
      const whole = lines.join(' ');
      const tr = parseTimeRange(whole) || rowTime;
      if (!tr) { errs.push((r + 1) + '번째 줄 ' + DOW[dayCols[c]] + '요일: 시간을 읽지 못했어요 (' + whole.slice(0, 30) + ')'); return; }
      let teacherText = '';
      const paren = /[(（]([^)）]+)[)）]/.exec(whole); if (paren && match(paren[1])) teacherText = paren[1];
      let rest = lines.filter(l => !parseTimeRange(l) || norm(l).replace(parseTimeRange(l).text, '').trim().length > 0).map(l => { const t = parseTimeRange(l); return t ? norm(l.replace(t.text, '')) : l; }).filter(Boolean);
      if (!teacherText) {
        for (const l of rest) { const words = l.split(/\s+/); const hit = words.find(w => match(w)); if (hit) { teacherText = hit; break; } }
        if (!teacherText && rest.length > 1 && match(rest[rest.length - 1])) teacherText = rest[rest.length - 1];
      }
      let name = rest.join(' ');
      if (teacherText) name = name.replace('(' + teacherText + ')', ' ').replace('（' + teacherText + '）', ' ').replace(teacherText, ' ');
      name = cleanName(name.replace(/\s+/g, ' '));
      if (!name) { errs.push((r + 1) + '번째 줄 ' + DOW[dayCols[c]] + '요일: 수업명을 읽지 못했어요'); return; }
      out.push({ name, days: [dayCols[c]], start: tr.start, end: tr.end, teacherText, cap: null });
    });
  }
  return { slots: out, errs };
}

function mergeDays(slots) {
  const map = new Map();
  slots.forEach(s => {
    const k = [nkey(s.name), nkey(s.teacherText), s.start, s.end].join('|');
    if (!map.has(k)) map.set(k, Object.assign({}, s, { days: s.days.slice() }));
    else { const e = map.get(k); s.days.forEach(d => { if (e.days.indexOf(d) < 0) e.days.push(d); }); if (s.cap && !e.cap) e.cap = s.cap; }
  });
  return [...map.values()].map(s => Object.assign(s, { days: DOW_ORDER.filter(d => s.days.indexOf(d) >= 0) }));
}

export function parseScheduleRows(rows, teachers) {
  const h = findHeader(rows, SCHED_ROLES);
  if (h && h.cols.name != null && h.cols.days != null && (h.cols.time != null || (h.cols.start != null && h.cols.end != null))) {
    const r = listLayout(rows, h); return { slots: mergeDays(r.slots), errs: r.errs, layout: '목록형' };
  }
  const g = gridLayout(rows, teachers);
  if (g && g.slots.length) return { slots: mergeDays(g.slots), errs: g.errs, layout: '요일 칸 표' };
  return { slots: [], errs: ['시간표 모양을 알아보지 못했어요. 첫 줄에 "수업명, 요일, 시간, 센세" 제목을 넣거나, 요일(월~일)이 가로로 놓인 표로 만들어주세요. 아니면 아래 칸에 한 줄에 한 수업씩 붙여넣어도 됩니다.'], layout: '' };
}

// 붙여넣기: 한 줄에 수업 하나.  수업명 | 요일 | 시작-끝 | 센세 | 정원(선택)
export function parseScheduleText(text) {
  const rows = [['수업명', '요일', '시간', '센세', '정원']];
  text.split(/\r?\n/).forEach(line => {
    const raw = line.trim(); if (!raw) return;
    let parts = raw.split(/\t|\|/).map(norm);
    if (parts.length < 3 && raw.split(',').length >= 3) parts = raw.split(',').map(norm);
    if (/^(수업명?|강의)$/.test(parts[0])) return;
    rows.push(parts);
  });
  const r = listLayout(rows, { row: 0, cols: { name: 0, days: 1, time: 2, teacher: 3, cap: 4 } });
  return { slots: mergeDays(r.slots), errs: r.errs, layout: '붙여넣기' };
}

/* ---------- 시간표 바꾸기 계획 ---------- */
const slotKey = s => [nkey(s.name), s.teacher, (s.days || []).slice().sort().join(''), s.start, s.end].join('|');
const isActiveAt = (s, date) => !s.to || s.to >= date;

// parsed: parseSchedule* 결과 slots (teacherText 포함). teacherMap: {원문: 센세id | '__new__'}
export function planSchedule(sched, parsed, effective, teacherMap) {
  const teachers = (sched && sched.teachers) || {};
  const match = teacherMatcher(teachers);
  const unresolved = [];
  const resolved = parsed.map(p => {
    let tid = null;
    if (p.teacherText) tid = match(p.teacherText) || (teacherMap && teacherMap[p.teacherText] && teacherMap[p.teacherText] !== '__new__' ? teacherMap[p.teacherText] : null);
    if (!tid && p.teacherText && unresolved.indexOf(p.teacherText) < 0) unresolved.push(p.teacherText);
    if (!p.teacherText && unresolved.indexOf('') < 0) unresolved.push('');
    return Object.assign({}, p, { teacher: tid });
  });
  const oldSlots = Object.keys((sched && sched.slots) || {}).map(id => Object.assign({ id }, sched.slots[id])).filter(s => isActiveAt(s, effective));
  const oldByKey = new Map(); oldSlots.forEach(s => oldByKey.set(slotKey(s), s));
  const keep = [], add = [], seen = new Set();
  resolved.forEach(p => {
    const k = slotKey(p);
    const old = p.teacher ? oldByKey.get(k) : null;
    if (old) { keep.push(old); seen.add(old.id); }
    else add.push(Object.assign({}, p, { cap: p.cap || defaultCap(p.start, p.end) }));
  });
  const end = oldSlots.filter(s => !seen.has(s.id));
  return { keep, add, end, unresolved, resolved };
}

// 계획을 실제 시간표 문서로 바꿉니다. endIds: 종료할 수업 id 목록 (체크 해제한 건 그대로 유지)
export function applySchedulePlan(sched, plan, effective, endIds, teacherMap) {
  const next = JSON.parse(JSON.stringify(sched));
  next.teachers = next.teachers || {}; next.slots = next.slots || {};
  const prevDay = addDays(effective, -1);
  const tmap = {};
  const tid = text => {
    if (tmap[text]) return tmap[text];
    const match = teacherMatcher(next.teachers);
    let id = match(text);
    const choice = teacherMap && teacherMap[text];
    if (!id && choice && choice !== '__new__' && next.teachers[choice]) {
      id = choice;
      const t = next.teachers[id]; t.aliases = (t.aliases || []).concat(text).filter((x, i, a) => a.indexOf(x) === i);
    }
    if (!id) { id = newId('t'); next.teachers[id] = { name: text.replace(/\s*(센세|선생님)$/, '') + '센세' }; }
    return (tmap[text] = id);
  };
  (endIds || []).forEach(id => {
    const s = next.slots[id]; if (!s) return;
    if (s.from && s.from >= effective) delete next.slots[id];   // 아직 시작도 안 한 수업은 그냥 지움
    else s.to = prevDay;
  });
  plan.add.forEach(p => {
    const teacher = p.teacher || (p.teacherText ? tid(p.teacherText) : null);
    if (!teacher) return;
    const id = newId('s');
    next.slots[id] = { name: p.name, teacher, cap: p.cap, days: p.days, start: p.start, end: p.end, from: effective };
  });
  return next;
}

export { minutesBetween };
