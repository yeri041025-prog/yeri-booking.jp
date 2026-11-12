// 시간표와 센세 목록은 Firestore 의 config/schedule 문서에 저장됩니다. (원장님 화면의 "수업 관리"에서 고칩니다)
// 문서 모양: { teachers: { <센세id>: {name} }, slots: { <수업id>: {name, teacher, cap, days:[0-6], start, end} } }
// 이 파일에는 화면에 쓰는 도우미 함수와, 처음 한 번 불러올 기본 시간표(SEED)만 있습니다.

export const DOW = ['일', '월', '화', '수', '목', '금', '토'];
export const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0]; // 월~일 순서로 보여주기
export const MAX_AHEAD = 3; // 이번 달부터 몇 달 뒤까지 볼 수 있는지

// 수업 길이별 기본 정원: 50분 수업 5명, 70~100분 수업 10명, 120분 이상 14명
// (51~69분은 5명, 101~119분은 10명으로 가까운 쪽에 맞춥니다)
export const minutesBetween = (start, end) => (+end.slice(0, 2)) * 60 + (+end.slice(3, 5)) - ((+start.slice(0, 2)) * 60 + (+start.slice(3, 5)));
export const capForMinutes = m => (m >= 120 ? 14 : (m >= 70 ? 10 : 5));
// 120분 이상 수업은 2회, 그 외는 1회가 차감됩니다.
export const costForMinutes = m => (m >= 120 ? 2 : 1);
export const slotCost = s => costForMinutes(minutesBetween(s.start, s.end));
export const defaultCap = (start, end) => capForMinutes(minutesBetween(start, end));

// days: 0=일 1=월 2=화 3=수 4=목 5=금 6=토
// 이 달의 시간표 (원장님 화면 "수업 관리"의 "이번 달 시간표로 바꾸기" 버튼이 이 내용으로 바꿔줍니다)
// 정원은 수업 길이 규칙을 따릅니다: 50분 5명, 70~100분 10명, 120분 이상 14명
export const SEED_LABEL = '2026년 11월';
export const SEED = {
  teachers: {
    yeri: { name: '예리센세' },
    sara: { name: '사라센세' },
    noa: { name: '노아센세' },
    malang: { name: '말랑센세' }
  },
  slots: {
    k1: { name: '기초일본어 통문장회화', teacher: 'noa', cap: 10, days: [0], start: '13:45', end: '15:15' },
    p1: { name: '일본어 패턴회화', teacher: 'sara', cap: 10, days: [2, 4], start: '14:00', end: '15:20' },
    p2: { name: '일본어 패턴회화', teacher: 'sara', cap: 10, days: [1, 3], start: '18:30', end: '19:50' },
    p3: { name: '일본어 패턴회화', teacher: 'sara', cap: 10, days: [2, 4], start: '19:50', end: '21:10' },
    p4: { name: '일본어 패턴회화', teacher: 'sara', cap: 14, days: [6], start: '11:00', end: '13:00' },
    t1: { name: '일본어 테마회화&자유회화 (上)', teacher: 'noa', cap: 10, days: [1, 3], start: '10:20', end: '11:40' },
    t2: { name: '일본어 테마회화&자유회화 (中)', teacher: 'sara', cap: 10, days: [1, 3], start: '14:00', end: '15:20' },
    t3: { name: '일본어 테마회화&자유회화 (中)', teacher: 'sara', cap: 10, days: [1, 3], start: '20:00', end: '21:20' },
    t4: { name: '일본어 테마회화&자유회화 (上)', teacher: 'sara', cap: 14, days: [5], start: '19:00', end: '21:00' },
    t5: { name: '일본어 테마회화&자유회화 (上)', teacher: 'noa', cap: 10, days: [0], start: '11:00', end: '12:30' },
    a1: { name: '애니&JPOP 일본어', teacher: 'noa', cap: 5, days: [2, 4], start: '12:00', end: '12:50' },
    a2: { name: '애니&JPOP 일본어', teacher: 'noa', cap: 10, days: [5], start: '19:30', end: '21:00' },
    e1: { name: '센세에몽의 회화포켓', teacher: 'yeri', cap: 10, days: [1, 3], start: '19:55', end: '21:15' },
    e2: { name: '센세에몽의 회화포켓', teacher: 'yeri', cap: 14, days: [5], start: '18:40', end: '20:50' },
    e3: { name: '센세에몽의 회화포켓', teacher: 'yeri', cap: 14, days: [6], start: '11:00', end: '13:00' },
    e4: { name: '센세에몽의 회화포켓', teacher: 'malang', cap: 10, days: [6], start: '16:00', end: '17:20' }
  }
};

export function slotList(sched) {
  const slots = (sched && sched.slots) || {};
  return Object.keys(slots).map(id => Object.assign({ id }, slots[id]));
}
// date 를 주면, 수업에 적용 기간(from~to)이 있을 때 그 날짜가 기간 안인 수업만 돌려줍니다.
export function slotsFor(sched, dow, teacher, date) {
  return slotList(sched)
    .filter(s => (s.days || []).indexOf(dow) >= 0 && (!teacher || s.teacher === teacher)
      && (!date || ((!s.from || s.from <= date) && (!s.to || date <= s.to))))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : (a.name < b.name ? -1 : 1)));
}
export function teacherName(sched, id) {
  const t = sched && sched.teachers && sched.teachers[id];
  return (t && t.name) || '담당 미정';
}
export function teacherIds(sched) {
  return Object.keys((sched && sched.teachers) || {}).sort((a, b) => teacherName(sched, a).localeCompare(teacherName(sched, b), 'ko'));
}
export function teachersWithSlots(sched) {
  const used = {};
  slotList(sched).forEach(s => { used[s.teacher] = true; });
  return teacherIds(sched).filter(id => used[id]);
}
export const daysLabel = days => DOW_ORDER.filter(d => (days || []).indexOf(d) >= 0).map(d => DOW[d]).join('·');
export const newId = prefix => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

export function kstToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}
export const parseDate = s => { const p = s.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); };
export const addDays = (s, n) => new Date(parseDate(s).getTime() + n * 86400000).toISOString().slice(0, 10);
export function kstNowHM() {
  return new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}
export const fmtDate = d => d.toISOString().slice(0, 10);
export const shiftMonth = (ym, n) => { const p = ym.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1 + n, 1)).toISOString().slice(0, 7); };
export const monthIndex = ym => { const p = ym.split('-'); return (+p[0]) * 12 + (+p[1]); };

export function monthDays(ym) {
  const p = ym.split('-'), mo = +p[1] - 1, out = [];
  let d = new Date(Date.UTC(+p[0], mo, 1));
  while (d.getUTCMonth() === mo) {
    out.push({ date: fmtDate(d), dow: d.getUTCDay(), m: d.getUTCMonth() + 1, d: d.getUTCDate() });
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}
export function weekKey(date) {
  const d = parseDate(date), diff = (d.getUTCDay() + 6) % 7;
  return fmtDate(new Date(d.getTime() - diff * 86400000));
}
export function groupByWeek(days) {
  const groups = {}, order = [];
  days.forEach(day => { const k = weekKey(day.date); if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(day); });
  return order.map(k => ({ monday: k, days: groups[k] }));
}
export function statusOf(n, cap) {
  if (n >= cap) return ['full', '마감'];
  if (cap - n <= Math.max(1, Math.floor(cap / 4))) return ['warn', '마감 임박'];
  return ['ok', '여유'];
}
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- 수강생(수강권) ---------- */
// 수강생 문서 이름: 이름과 전화번호 뒤 4자리로 만든 값. 원장님 화면과 수강생 화면이 같은 값을 만들어야 합니다.
export async function memberKey(name, last4) {
  const norm = String(name).normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase() + '|' + String(last4).trim();
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('member|' + norm));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
export const daysBetween = (a, b) => Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86400000);
export const dotDate = s => s.replace(/-/g, '.');

// 수강권 상태: 오늘 날짜 기준 남은 일수, 총 일수, 상태
export function passInfo(m, today) {
  const total = Math.max(1, daysBetween(m.start, m.end) + 1);
  let left, state;
  if (today < m.start) { left = total; state = 'before'; }
  else if (today > m.end) { left = 0; state = 'expired'; }
  else { left = daysBetween(today, m.end) + 1; state = 'active'; }
  if (state === 'active' && (m.credits || 0) <= 0) state = 'empty';
  return { total, left, state };
}
export const PASS_STATE = { active: '이용중', before: '시작 전', expired: '기간 만료', empty: '횟수 소진' };

// 수업 시작 12시간 전까지만 취소할 수 있습니다. 12시간 이내 취소·불참은 크레딧이 차감됩니다. (한국시간 기준)
export const CANCEL_HOURS = 12;
export function cancelDeadline(date, start) {
  return new Date(date + 'T' + start + ':00+09:00').getTime() - CANCEL_HOURS * 3600000;
}
// 12시간 전까지: 취소하면 크레딧이 돌아옵니다.
export const canCancel = (date, start, now) => (now == null ? Date.now() : now) < cancelDeadline(date, start);
// 수업이 시작되기 전까지는 취소할 수 있습니다. (12시간 이내 취소는 크레딧이 돌아오지 않습니다)
export const canCancelAny = (date, start, now) => (now == null ? Date.now() : now) < new Date(date + 'T' + start + ':00+09:00').getTime();

/* ---------- 예약 오픈 규칙 ----------
   매월 20일부터 다음 달 수업을 예약할 수 있습니다.
   (이번 달 수업이 다음 달 초까지 이어질 수 있어서, 다음 달 1~4일은 항상 열려 있고 5일부터가 '다음 달 시간표'입니다.)
   - 1~19일: 다음 달 4일까지 예약 가능
   - 20일~말일: 다다음 달 4일까지 예약 가능 */
export const OPEN_DAY = 20;
export const OPEN_EDGE = 5;
export function openLimit(today) {            // 이 날짜 '전'까지만 예약 가능 (YYYY-MM-DD)
  const ym = today.slice(0, 7), day = +today.slice(8, 10);
  return shiftMonth(ym, day >= OPEN_DAY ? 2 : 1) + '-0' + OPEN_EDGE;
}
export const isOpenDate = (date, today) => date < openLimit(today);
// 아직 열리지 않은 날짜가 언제 열리는지 (예: '10월 20일')
export function opensOn(date) {
  const ym = shiftMonth(date.slice(0, 7), -1);
  return (+ym.slice(5, 7)) + '월 ' + OPEN_DAY + '일';
}
