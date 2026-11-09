import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where, onSnapshot, writeBatch, increment }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { firebaseConfig, ADMIN_EMAIL } from "./firebase-config.js";
import {
  DOW, DOW_ORDER, MAX_AHEAD, SEED, SEED_LABEL, slotList, slotsFor, teacherName, teacherIds, teachersWithSlots, daysLabel, newId,
  kstToday, shiftMonth, monthIndex, monthDays, groupByWeek, parseDate, statusOf, esc,
  memberKey, passInfo, PASS_STATE, dotDate, minutesBetween, capForMinutes, defaultCap
} from "./schedule.js";
import { initImport } from "./staff-import.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const today = kstToday();
const thisMonth = today.slice(0, 7);
let viewMonth = thisMonth;
let role = null, myTeacher = null;     // role: 'admin' | 'teacher'
let sched = null, schedLoaded = false;
let bookings = [], staffDocs = [], members = [], topics = {};
let memberSearch = '';
let editingMember = null;              // null | 수강생 문서 이름
let view = 'bookings';
let filterTeacher = 'all';
let openDate = null, openSlot = null;
let editing = null;                    // null | 'new' | 수업id
let renaming = null;                   // 이름 바꾸는 센세 id
const feedback = {}, confirmCancel = {};
let unsubTopics = null, unsubBookings = null, unsubStaff = null, unsubSched = null, unsubMembers = null;
let userEmail = '';
function updateWho() {
  if (!role) return;
  $('who').textContent = userEmail + ' · ' + (role === 'admin' ? '관리자' : (sched ? teacherName(sched, myTeacher) : '센세'));
}

const $ = id => document.getElementById(id);
const key = (date, slot) => date + '_' + slot;
const clone = o => JSON.parse(JSON.stringify(o));
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const rowsOf = (date, slot) => bookings.filter(b => b.date === date && b.slot === slot).sort((a, b) => a.n - b.n);
function showNotice(t) { const n = $('notice'); n.textContent = t; n.hidden = !t; }
function setMsg(id, ok, text) { const el = $(id); if (!el) return; el.className = 'msg' + (ok ? ' good' : ' err'); el.textContent = text; }

/* ---------- 입력값 보존 (실시간 갱신으로 다시 그려도 입력 중인 글자가 사라지지 않게) ---------- */
function capture(container) {
  const saved = {};
  container.querySelectorAll('input[id],select[id],textarea[id]').forEach(i => { if (i.type === 'file') return; saved[i.id] = i.type === 'checkbox' ? i.checked : i.value; });
  return saved;
}
function restore(container, saved) {
  container.querySelectorAll('input[id],select[id],textarea[id]').forEach(i => {
    if (!(i.id in saved) || i.type === 'file') return;
    if (i.type === 'checkbox') i.checked = saved[i.id]; else i.value = saved[i.id];
  });
}
function paint(container, html, preserve) {
  const saved = preserve ? capture(container) : {};
  const focusId = document.activeElement && document.activeElement.id;
  container.innerHTML = html;
  if (preserve) restore(container, saved);
  if (focusId) { const el = $(focusId); if (el && container.contains(el)) el.focus(); }
}

/* ---------- 예약 현황 ---------- */
function visibleTeacherFilter() { return role === 'teacher' ? myTeacher : (filterTeacher === 'all' ? null : filterTeacher); }

function renderChips() {
  const el = $('chips');
  if (role !== 'admin' || !sched) { el.hidden = true; return; }
  const ids = teachersWithSlots(sched);
  if (filterTeacher !== 'all' && ids.indexOf(filterTeacher) < 0) filterTeacher = 'all';
  if (ids.length < 2) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = '<button class="chip' + (filterTeacher === 'all' ? ' on' : '') + '" type="button" data-teacher="all">전체</button>'
    + ids.map(id => '<button class="chip' + (filterTeacher === id ? ' on' : '') + '" type="button" data-teacher="' + esc(id) + '">' + esc(teacherName(sched, id)) + '</button>').join('');
}

function cancelButtons(r) {
  if (!confirmCancel[r.id]) return '<button class="act" type="button" data-cancel="' + esc(r.id) + '">취소</button>';
  return '<span class="btns"><button class="act danger" type="button" data-cancel-refund="' + esc(r.id) + '">횟수 돌려주고 취소</button>'
    + '<button class="act danger" type="button" data-cancel-keep="' + esc(r.id) + '">횟수 차감한 채 취소</button>'
    + '<button class="act" type="button" data-cancel-abort="' + esc(r.id) + '">닫기</button></span>';
}

function renderSession(day, slot) {
  const rows = rowsOf(day.date, slot.id), n = rows.length, st = statusOf(n, slot.cap);
  const k = key(day.date, slot.id), isOpen = true;
  let seats = ''; for (let i = 0; i < slot.cap; i++) seats += '<span class="seat' + (i < n ? ' on' : '') + '"></span>';
  let h = '<div class="sess"><button class="shead" type="button" data-slot="' + esc(slot.id) + '" aria-expanded="' + isOpen + '">'
    + '<span class="time">' + esc(slot.start) + '–' + esc(slot.end) + '</span>'
    + '<span class="sinfo"><b>' + esc(slot.name) + '</b><small>' + esc(teacherName(sched, slot.teacher)) + '</small><span class="seats" aria-hidden="true">' + seats + '</span></span>'
    + '<span class="count">' + n + '/' + slot.cap + '<span class="pill ' + st[0] + '">' + st[1] + '</span></span></button>';
  if (isOpen) {
    h += '<div class="sbody">';
    const canEdit = role === 'admin' || slot.teacher === myTeacher;
    h += canEdit
      ? '<div class="topicrow"><label for="tp_' + esc(k) + '">이날의 주제</label><input id="tp_' + esc(k) + '" data-topic-in maxlength="60" value="' + esc(topics[k] || '') + '" placeholder="예: ～ようと思う 말하기 연습 (학생에게 보여요)"><button class="act" type="button" data-topic-save="' + esc(day.date + '|' + slot.id) + '">저장</button></div>'
      : (topics[k] ? '<p class="topic"><b>이날의 주제</b>' + esc(topics[k]) + '</p>' : '');
    if (!rows.length) h += '<p class="empty">아직 예약이 없습니다.</p>';
    else {
      h += '<ul class="roster">' + rows.map(r =>
        '<li><span class="nm">' + esc(r.name) + '<small>' + esc(r.last4) + '</small></span>'
        + (role === 'admin' ? cancelButtons(r) : '')
        + '</li>').join('') + '</ul>';
    }
    const f = feedback[k];
    h += '<p class="msg' + (f ? (f.ok ? ' good' : ' err') : '') + '" role="status">' + (f ? esc(f.text) : '') + '</p></div>';
  }
  return h + '</div>';
}

// 달력 칸에 쓸 하루치 숫자: 예약 수, 수업 수, 정원 합계
function dayStats(date, dow, only) {
  const sl = sched ? slotsFor(sched, dow, only, date) : [];
  let n = 0, cap = 0;
  sl.forEach(x => { n += rowsOf(date, x.id).length; cap += x.cap; });
  return { sl, n, cap };
}
function monthCells(ym) {
  const days = monthDays(ym), lead = (parseDate(ym + '-01').getUTCDay() + 6) % 7;
  const cells = new Array(lead).fill(null).concat(days);
  while (cells.length % 7) cells.push(null);
  return cells;
}

function renderBookings() {
  const p = viewMonth.split('-');
  $('month-label').textContent = p[0] + '년 ' + (+p[1]) + '월';
  $('prev').disabled = monthIndex(viewMonth) <= monthIndex(thisMonth) - 2; // 지난 2개월까지 열람
  $('next').disabled = monthIndex(viewMonth) >= monthIndex(thisMonth) + MAX_AHEAD;
  renderChips();
  if (!sched) {
    $('list').innerHTML = '<p class="empty">' + (schedLoaded ? '시간표가 아직 없습니다. ' + (role === 'admin' ? '"수업 관리" 탭에서 만들어주세요.' : '원장님께 문의해주세요.') : '불러오는 중입니다…') + '</p>';
    return;
  }
  const only = visibleTeacherFilter();
  const cells = monthCells(viewMonth);
  // 이번 달 합계 (센세별)
  const perTeacher = {}; let total = 0, sessions = 0;
  cells.forEach(day => {
    if (!day) return;
    slotsFor(sched, day.dow, null, day.date).forEach(sl => {
      const n = rowsOf(day.date, sl.id).length;
      const t = perTeacher[sl.teacher] = perTeacher[sl.teacher] || { n: 0, sessions: 0 };
      t.n += n; t.sessions++;
    });
  });
  const ids = Object.keys(perTeacher).filter(id => !only || id === only);
  ids.forEach(id => { total += perTeacher[id].n; sessions += perTeacher[id].sessions; });
  if (!openDate || openDate.slice(0, 7) !== viewMonth) {
    const pickable = cells.filter(d => d && dayStats(d.date, d.dow, only).sl.length);
    const inMonth = pickable.find(d => d.date === today) || pickable.find(d => d.date > today) || pickable[pickable.length - 1];
    openDate = inMonth ? inMonth.date : null;
  }
  const label = only ? teacherName(sched, only) : '전체';
  let html = '<section class="bsum"><div class="bsum-main"><span class="bsum-title">' + esc(label) + ' · ' + (+p[1]) + '월</span>'
    + '<b class="bsum-num">' + total + '<small>명 예약</small></b><span class="bsum-sub">수업 ' + sessions + '회</span></div>';
  if (!only && role === 'admin' && Object.keys(perTeacher).length > 1) {
    html += '<div class="bsum-teachers">' + Object.keys(perTeacher).sort((a, b) => perTeacher[b].n - perTeacher[a].n).map(id =>
      '<button class="bt" type="button" data-teacher="' + esc(id) + '"><span>' + esc(teacherName(sched, id)) + '</span><b>' + perTeacher[id].n + '</b><small>수업 ' + perTeacher[id].sessions + '회</small></button>').join('') + '</div>';
  }
  html += '</section>';
  // 달력
  html += '<div class="cal-layout"><section class="cal" aria-label="월간 예약 달력"><div class="cal-head">'
    + DOW_ORDER.map(d => '<span' + (d === 0 ? ' class="sun"' : (d === 6 ? ' class="sat"' : '')) + '>' + DOW[d] + '</span>').join('') + '</div><div class="cal-grid">'
    + cells.map(day => {
      if (!day) return '<span class="cal-cell blank"></span>';
      const st = dayStats(day.date, day.dow, only);
      if (!st.sl.length) return '<span class="cal-cell none' + (day.date === today ? ' today' : '') + '"><span class="cd">' + day.d + '</span></span>';
      const ratio = st.cap ? st.n / st.cap : 0, lvl = st.n === 0 ? 0 : (ratio < 0.5 ? 1 : (ratio < 0.9 ? 2 : 3));
      return '<button class="cal-cell has lvl' + lvl + (day.date === openDate ? ' sel' : '') + (day.date === today ? ' today' : '') + (day.date < today ? ' past' : '') + '" type="button" data-pick="' + day.date + '" aria-pressed="' + (day.date === openDate) + '" aria-label="' + day.m + '월 ' + day.d + '일 예약 ' + st.n + '명, 수업 ' + st.sl.length + '개">'
        + '<span class="cd">' + day.d + '</span><span class="cn">' + st.n + '<small>명</small></span><span class="cs">수업 ' + st.sl.length + '</span></button>';
    }).join('') + '</div><p class="cal-legend"><i class="lg lvl0"></i>예약 없음 <i class="lg lvl1"></i>여유 <i class="lg lvl2"></i>절반 이상 <i class="lg lvl3"></i>거의 마감</p></section>';
  // 선택한 날의 상세
  html += '<aside class="daypane" aria-live="polite">';
  if (!openDate) html += '<p class="empty">이 달에는 표시할 수업이 없습니다.</p>';
  else {
    const d = parseDate(openDate), day = { date: openDate, dow: d.getUTCDay(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
    const st = dayStats(openDate, day.dow, only);
    html += '<div class="dp-head"><b>' + day.m + '월 ' + day.d + '일 (' + DOW[day.dow] + ')' + (openDate === today ? ' · 오늘' : '') + '</b><span>예약 ' + st.n + '명 · 수업 ' + st.sl.length + '개</span></div>';
    html += st.sl.length ? st.sl.map(sl => renderSession(day, sl)).join('') : '<p class="empty">이 날은 수업이 없습니다.</p>';
  }
  html += '</aside></div>';
  $('list').innerHTML = html;
}

/* ---------- 수업 관리 (원장) ---------- */
function seedPanel() {
  return '<section class="panel"><h2>시간표가 아직 없습니다</h2>'
    + '<p class="hint">처음 한 번만 기본 시간표(사라센세, 노아센세 수업과 예리센세 이름)를 불러옵니다. 이후에는 이 화면에서 자유롭게 고칠 수 있어요.</p>'
    + '<div><button id="seed-btn" class="primary" type="button">기본 시간표 만들기</button></div>'
    + '<p id="seed-msg" class="msg" role="status"></p></section>';
}

function seedReplacePanel() {
  const hidden = bookings.filter(b => b.date >= today && !(SEED.slots && SEED.slots[b.slot])).length;
  const asking = confirmCancel.seedreplace;
  return '<section class="panel"><h2>' + esc(SEED_LABEL) + ' 시간표로 바꾸기</h2>'
    + '<p class="hint">수업 목록을 ' + esc(SEED_LABEL) + ' 시간표(기초일본어 통문장회화, 센세에몽의 회화포켓, 일본어 패턴회화, 일본어 테마회화&자유회화, 애니&JPOP 일본어)로 한 번에 바꿉니다. 센세 목록은 그대로 두고, 없는 센세(말랑센세)만 추가합니다. 정원은 수업 길이 규칙으로 들어갑니다.</p>'
    + '<p class="hint"><b>지금 있는 수업은 모두 사라지고</b>, 그 수업에 앞으로 예약된 ' + hidden + '건은 화면에서 보이지 않게 됩니다. (기록은 남습니다)</p>'
    + '<div class="btnrow"><button id="seed-replace" class="act' + (asking ? ' danger' : '') + '" type="button">' + (asking ? '정말 바꿉니다. 한 번 더 누르면 적용' : esc(SEED_LABEL) + ' 시간표로 바꾸기') + '</button></div>'
    + '<p id="seedreplace-msg" class="msg" role="status"></p></section>';
}

const CAP_RULE = '50분 5명 · 70~100분 10명 · 120분 이상 14명';
function capHint(start, end) {
  if (!start || !end || start >= end) return '시작과 끝 시간을 고르면 수업 길이에 맞는 정원을 안내합니다. (' + CAP_RULE + ')';
  const m = minutesBetween(start, end);
  return '수업 길이 ' + m + '분 → 권장 정원 ' + capForMinutes(m) + '명 (' + CAP_RULE + ')';
}

function slotFormHtml() {
  const isNew = editing === 'new';
  const cur = isNew ? { name: '', teacher: teacherIds(sched)[0] || '', cap: 10, days: [], start: '', end: '' } : Object.assign({}, sched.slots[editing]);
  const teacherOpts = teacherIds(sched).map(id => '<option value="' + esc(id) + '"' + (cur.teacher === id ? ' selected' : '') + '>' + esc(teacherName(sched, id)) + '</option>').join('');
  const dayBoxes = DOW_ORDER.map(d => '<label><input type="checkbox" id="sf-day-' + d + '"' + ((cur.days || []).indexOf(d) >= 0 ? ' checked' : '') + '>' + DOW[d] + '</label>').join('');
  return '<form id="slot-form" class="stack" autocomplete="off">'
    + '<label>수업명<input id="sf-name" maxlength="40" required value="' + esc(cur.name) + '"></label>'
    + '<div class="grid2"><label>담당 센세<select id="sf-teacher">' + teacherOpts + '</select></label>'
    + '<label>정원(명)<input id="sf-cap" type="number" min="1" max="30" required value="' + esc(cur.cap) + '"></label></div>'
    + '<p id="sf-caphint" class="hint">' + capHint(cur.start, cur.end) + '</p>'
    + '<fieldset class="days"><legend>요일</legend>' + dayBoxes + '</fieldset>'
    + '<div class="grid2"><label>적용 시작일 (비우면 계속)<input id="sf-from" type="date" value="' + esc(cur.from || '') + '"></label>'
    + '<label>적용 종료일 (비우면 계속)<input id="sf-to" type="date" value="' + esc(cur.to || '') + '"></label></div>'
    + '<p class="hint">달이 바뀌면서 시간이 달라지는 수업은, 지난 시간표 수업의 종료일을 말일로 하고 새 수업을 다음 달 1일 시작으로 추가하세요. 그러면 이번 달 수업은 그대로 유지됩니다.</p>'
    + '<div class="grid2"><label>시작<input id="sf-start" type="time" required value="' + esc(cur.start) + '"></label>'
    + '<label>끝<input id="sf-end" type="time" required value="' + esc(cur.end) + '"></label></div>'
    + '<div class="btnrow"><button class="primary" type="submit">' + (isNew ? '수업 추가' : '수정 저장') + '</button>'
    + '<button id="slot-cancel" class="act" type="button">취소</button></div>'
    + '<p id="slot-msg" class="msg" role="status"></p></form>';
}

function renderSchedule(preserve) {
  const el = $('view-schedule');
  if (!sched) { paint(el, seedPanel(), false); return; }
  const list = slotList(sched).sort((a, b) => teacherName(sched, a.teacher).localeCompare(teacherName(sched, b.teacher), 'ko')
    || (a.start < b.start ? -1 : 1));
  let html = '<section class="panel"><h2>수업 목록</h2>';
  if (!teacherIds(sched).length) html += '<p class="hint">먼저 "센세 관리" 탭에서 센세를 추가해주세요.</p>';
  if (!list.length) html += '<p class="empty">등록된 수업이 없습니다.</p>';
  else {
    const liOf = s => s.id === editing ? '<li class="editing" style="display:block">' + slotFormHtml() + '</li>' : '<li' + (s.to && s.to < today ? ' class="ended"' : '') + '><span class="info"><b>' + esc(s.name) + '</b><small>' + esc(teacherName(sched, s.teacher)) + ' · ' + esc(daysLabel(s.days)) + ' ' + esc(s.start) + '–' + esc(s.end) + ' · 정원 ' + esc(s.cap) + '명'
      + (s.from || s.to ? ' · 적용 ' + esc(s.from ? dotDate(s.from) : '처음') + ' ~ ' + esc(s.to ? dotDate(s.to) : '계속') : '') + '</small></span>'
      + '<span class="btns"><button class="act" type="button" data-editslot="' + esc(s.id) + '">수정</button>'
      + '<button class="act' + (confirmCancel['slot_' + s.id] ? ' danger' : '') + '" type="button" data-delslot="' + esc(s.id) + '">' + (confirmCancel['slot_' + s.id] ? '삭제 확인' : '삭제') + '</button></span></li>';
    const nowList = list.filter(s => !(s.to && s.to < today)), oldList = list.filter(s => s.to && s.to < today);
    html += '<ul class="slotlist">' + (nowList.map(liOf).join('') || '<li class="empty">지금 운영 중인 수업이 없습니다.</li>') + '</ul>';
    if (oldList.length) html += '<details class="oldslots"><summary>종료된 수업 ' + oldList.length + '개 (지난 예약을 보기 위해 남겨둔 시간표)</summary><ul class="slotlist">' + oldList.map(liOf).join('') + '</ul></details>';
  }
  html += '<p id="slotlist-msg" class="msg" role="status"></p>';
  html += '<p class="hint">수업을 삭제해도 이미 들어온 예약 기록은 남지만 화면에서는 보이지 않습니다. 정원을 줄여도 기존 예약은 그대로 유지됩니다.</p></section>';
  html += imp.schedImportHtml();
  const names = [...new Set(list.map(s => s.name))];
  if (names.length) {
    html += '<section class="panel"><h2>수업별 정원 한 번에 바꾸기</h2><form id="cap-form" class="stack" autocomplete="off">'
      + names.map((n, i) => {
        const caps = [...new Set(list.filter(s => s.name === n).map(s => s.cap))];
        return '<label>' + esc(n) + ' (' + list.filter(s => s.name === n).length + '개 시간대)<input id="capn-' + i + '" data-capname="' + esc(n) + '" type="number" min="1" max="30" value="' + (caps.length === 1 ? esc(caps[0]) : '') + '" placeholder="' + (caps.length === 1 ? '' : '시간대마다 다름') + '"></label>';
      }).join('')
      + '<div class="btnrow"><button class="primary" type="submit">정원 저장</button></div><p id="cap-msg" class="msg" role="status"></p></form>'
      + '<div class="btnrow"><button id="cap-auto" class="act' + (confirmCancel.capauto ? ' danger' : '') + '" type="button">' + (confirmCancel.capauto ? '모든 수업 정원을 바꿉니다. 한 번 더 누르면 적용' : '수업 길이에 맞춰 정원 자동 설정') + '</button></div>'
      + '<p id="capauto-msg" class="msg" role="status"></p>'
      + '<p class="hint">자동 설정 기준: ' + CAP_RULE + '. 개별 수업은 위 "수업 목록"에서 수정할 수 있습니다.</p>'
      + '<p class="hint">수강생 화면에는 정원이 보이지 않고, 남은 자리가 2석 이하일 때만 남은 자리 수가 보입니다.</p></section>';
  }
  html += '<section class="panel"><h2>' + (editing === 'new' ? '새 수업 추가' : (editing ? '수업 수정' : '수업 추가')) + '</h2>';
  if (editing === 'new') html += slotFormHtml();
  else if (editing && sched.slots[editing]) html += '<p class="hint">위 수업 목록에서 열린 수정 창에서 고쳐주세요.</p>';
  else html += '<div><button id="slot-new" class="primary" type="button"' + (teacherIds(sched).length ? '' : ' disabled') + '>+ 수업 추가</button></div>';
  html += '</section>';
  paint(el, html, preserve);
}

async function saveSlot() {
  const name = $('sf-name').value.trim(), teacher = $('sf-teacher').value, cap = parseInt($('sf-cap').value, 10);
  const days = DOW_ORDER.filter(d => $('sf-day-' + d).checked), start = $('sf-start').value, end = $('sf-end').value;
  if (!name) return setMsg('slot-msg', false, '수업명을 입력해주세요.');
  if (!sched.teachers[teacher]) return setMsg('slot-msg', false, '담당 센세를 골라주세요.');
  if (!(cap >= 1 && cap <= 30)) return setMsg('slot-msg', false, '정원은 1~30명으로 입력해주세요.');
  if (!days.length) return setMsg('slot-msg', false, '요일을 하나 이상 골라주세요.');
  if (!start || !end || start >= end) return setMsg('slot-msg', false, '시작 시간이 끝 시간보다 빨라야 합니다.');
  const from = $('sf-from').value, to = $('sf-to').value;
  if (from && to && from > to) return setMsg('slot-msg', false, '적용 종료일이 시작일보다 빠릅니다.');
  const isNew = editing === 'new', id = isNew ? newId('s') : editing;
  const before = isNew ? null : sched.slots[id];
  const next = clone(sched);
  next.slots[id] = { name, teacher, cap, days, start, end };
  if (from) next.slots[id].from = from;
  if (to) next.slots[id].to = to;
  try {
    await setDoc(doc(db, 'config', 'schedule'), next);
    if (before && before.teacher !== teacher) await migrateTeacher(id, teacher);
    editing = null; renderSchedule(false);
    setMsg('slotlist-msg', true, isNew ? '수업을 추가했습니다.' : '수정했습니다.');
  } catch (err) {
    setMsg('slot-msg', false, '저장하지 못했습니다. 잠시 후 다시 시도해주세요.');
  }
}

// 담당 센세를 바꾸면 이미 들어온 예약도 새 센세 화면에서 보이도록 옮깁니다.
async function migrateTeacher(slotId, teacher) {
  const snap = await getDocs(query(collection(db, 'bookings'), where('slot', '==', slotId)));
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = writeBatch(db);
    snap.docs.slice(i, i + 400).forEach(d => batch.update(d.ref, { teacher }));
    await batch.commit();
  }
}

async function deleteSlot(id) {
  const next = clone(sched); delete next.slots[id];
  try { await setDoc(doc(db, 'config', 'schedule'), next); delete confirmCancel['slot_' + id]; if (editing === id) editing = null; renderSchedule(false); setMsg('slotlist-msg', true, '삭제했습니다.'); }
  catch (err) { setMsg('slotlist-msg', false, '삭제하지 못했습니다.'); }
}

/* ---------- 수강생 관리 (원장) ---------- */
// 여러 명 한 번에 등록: 엑셀/구글시트에서 복사한 줄을 붙여넣습니다. (이름, 뒤 4자리, 시작일, 종료일, 횟수)
let bulkState = null;   // { rows, errs, warns, result }
function normDate(t) {
  const m = String(t).trim().replace(/[./]/g, '-').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return '';
  const iso = m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  return parseDate(iso).toISOString().slice(0, 10) === iso ? iso : '';
}
function parseBulk(text) {
  const rows = [], errs = [], warns = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const raw = line.trim(); if (!raw) return;
    let parts = raw.split(/\t|,/).map(x => x.trim()).filter(x => x !== '');
    if (parts.length < 5) { const m = raw.match(/^(.+?)\s+(\d{1,4})\s+(\S+)\s+(\S+)\s+(\d+)$/); if (m) parts = m.slice(1); }
    if (parts[0] === '이름') return; // 제목 줄
    const at = (i + 1) + '번째 줄(' + raw.slice(0, 20) + '): ';
    if (parts.length < 5) { errs.push(at + '이름, 뒤 4자리, 시작일, 종료일, 횟수 다섯 가지를 넣어주세요.'); return; }
    const name = parts[0];
    let last4 = parts[1];
    const start = normDate(parts[2]), end = normDate(parts[3]), credits = parseInt(parts[4], 10);
    if (!name || name.length > 20) { errs.push(at + '이름은 1~20자로 넣어주세요.'); return; }
    if (!/^\d{1,4}$/.test(last4)) { errs.push(at + '전화번호 뒤 4자리는 숫자 4자리로 넣어주세요.'); return; }
    if (last4.length < 4) { warns.push(name + ': 번호가 ' + last4.length + '자리라서 앞에 0을 붙여 ' + last4.padStart(4, '0') + '로 처리했어요.'); last4 = last4.padStart(4, '0'); }
    if (!start || !end) { errs.push(at + '날짜는 2026-11-01 또는 2026.11.01 모양으로 넣어주세요.'); return; }
    if (start > end) { errs.push(at + '종료일이 시작일보다 빠릅니다.'); return; }
    if (!(credits >= 1 && credits <= 999)) { errs.push(at + '횟수는 1 이상 숫자로 넣어주세요.'); return; }
    rows.push({ name, last4, start, end, credits });
  });
  return { rows, errs, warns };
}
function bulkHtml() {
  let h = '<section class="panel"><h2>여러 명 한 번에 등록</h2>'
    + '<p class="hint">엑셀이나 구글시트에서 <b>이름 · 뒤 4자리 · 시작일 · 종료일 · 횟수</b> 순서로 칸을 맞춰 복사해서 붙여넣으세요. 한 줄에 한 명입니다. 날짜는 2026-11-01 또는 2026.11.01 모양입니다.</p>'
    + '<textarea id="bulk-text" rows="5" placeholder="홍길동&#9;1234&#9;2026-11-01&#9;2027-01-31&#9;12"></textarea>'
    + '<div class="btnrow"><button id="bulk-preview" class="act" type="button">미리보기</button>';
  if (bulkState && bulkState.rows.length && !bulkState.result) h += '<button id="bulk-go" class="primary" type="button">' + bulkState.rows.length + '명 등록</button>';
  h += '</div>';
  if (bulkState) {
    if (bulkState.result) h += '<p class="msg good">' + esc(bulkState.result) + '</p>';
    else {
      h += '<p class="hint">등록할 수 있는 줄 ' + bulkState.rows.length + '개' + (bulkState.errs.length ? ', 고쳐야 할 줄 ' + bulkState.errs.length + '개' : '') + '</p>';
      if (bulkState.rows.length) h += '<ul class="slotlist">' + bulkState.rows.map(r => '<li><span class="info"><b>' + esc(r.name) + ' <small>' + esc(r.last4) + '</small></b><small>' + dotDate(r.start) + ' – ' + dotDate(r.end) + ' · ' + r.credits + '회</small></span></li>').join('') + '</ul>';
      if (bulkState.warns.length) h += '<p class="msg">' + bulkState.warns.map(esc).join('<br>') + '</p>';
      if (bulkState.errs.length) h += '<p class="msg err">' + bulkState.errs.map(esc).join('<br>') + '</p>';
    }
  }
  return h + '</section>';
}

function memberLine(m) {
  const info = passInfo(m, today);
  const left = info.state === 'before' ? '시작 전' : (info.state === 'expired' ? '기간 만료' : info.left + '일 남음');
  return dotDate(m.start) + ' – ' + dotDate(m.end) + ' · ' + left + ' · 횟수 ' + (m.credits || 0) + ' / ' + (m.total || 0);
}

function memberFormHtml(m) {
  return '<form id="member-edit-form" class="stack" autocomplete="off">'
    + '<div class="grid2"><label>이름<input id="me-name" maxlength="20" required value="' + esc(m.name) + '"></label>'
    + '<label>전화번호 뒤 4자리<input id="me-last4" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required value="' + esc(m.last4) + '"></label></div>'
    + '<p class="hint">이름이나 번호를 고치면 이미 잡힌 예약도 새 이름으로 같이 옮겨집니다. 수강생이 쓰던 기기에서는 새 이름과 번호로 다시 확인해야 합니다.</p>'
    + '<div class="grid2"><label>수강 시작<input id="me-start" type="date" required value="' + esc(m.start) + '"></label>'
    + '<label>수강 종료<input id="me-end" type="date" required value="' + esc(m.end) + '"></label></div>'
    + '<div class="grid3"><label>남은 횟수<input id="me-credits" type="number" min="0" max="999" required value="' + esc(m.credits || 0) + '"></label>'
    + '<label>총 횟수<input id="me-total" type="number" min="0" max="999" required value="' + esc(m.total || 0) + '"></label>'
    + '<label>횟수 추가(충전)<input id="me-add" type="number" min="0" max="999" placeholder="0"></label></div>'
    + '<p class="hint">"횟수 추가"에 숫자를 넣으면 남은 횟수와 총 횟수가 같이 늘어납니다.</p>'
    + '<div class="btnrow"><button class="primary" type="submit">저장</button><button id="member-edit-cancel" class="act" type="button">닫기</button></div>'
    + '<p id="member-edit-msg" class="msg" role="status"></p></form>';
}

function memberListHtml() {
  const q = memberSearch.trim().toLowerCase();
  const list = members.filter(m => !q || (m.name || '').toLowerCase().indexOf(q) >= 0 || (m.last4 || '').indexOf(q) >= 0)
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
  let html = '';
  if (!list.length) html += '<p class="empty">' + (members.length ? '찾는 수강생이 없습니다.' : '아직 등록된 수강생이 없습니다.') + '</p>';
  else {
    html += '<ul class="slotlist">' + list.map(m => {
      const info = passInfo(m, today);
      if (editingMember === m.id) return '<li style="display:block">' + memberFormHtml(m) + '</li>';
      return '<li><span class="info"><span class="mrow-meta"><b>' + esc(m.name) + '</b><small>' + esc(m.last4) + '</small>'
        + '<span class="pill ' + (info.state === 'active' ? 'ok' : (info.state === 'before' ? 'off' : 'full')) + '">' + PASS_STATE[info.state] + '</span></span>'
        + '<small>' + esc(memberLine(m)) + '</small></span>'
        + '<span class="btns"><button class="act" type="button" data-editmember="' + esc(m.id) + '">수정</button>'
        + '<button class="act' + (confirmCancel['m_' + m.id] ? ' danger' : '') + '" type="button" data-delmember="' + esc(m.id) + '">' + (confirmCancel['m_' + m.id] ? '삭제 확인' : '삭제') + '</button></span></li>';
    }).join('') + '</ul>';
  }
  return html;
}

function renderMembers(preserve) {
  const el = $('view-members');
  const q = memberSearch.trim().toLowerCase();
  const list = members.filter(m => !q || (m.name || '').toLowerCase().indexOf(q) >= 0 || (m.last4 || '').indexOf(q) >= 0)
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
  let html = '<section class="panel"><h2>수강생 등록</h2><form id="member-form" class="stack" autocomplete="off">'
    + '<div class="grid2"><label>이름<input id="mn-name" maxlength="20" required></label>'
    + '<label>전화번호 뒤 4자리<input id="mn-last4" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></label></div>'
    + '<div class="grid2"><label>수강 시작<input id="mn-start" type="date" required value="' + today + '"></label>'
    + '<label>수강 종료<input id="mn-end" type="date" required></label></div>'
    + '<div class="grid2"><label>횟수(크레딧)<input id="mn-credits" type="number" min="1" max="999" required></label><span></span></div>'
    + '<div class="btnrow"><button class="primary" type="submit">수강생 등록</button></div><p id="member-msg" class="msg" role="status"></p></form>'
    + '<p class="hint">등록된 수강생만 예약할 수 있습니다. 수강생은 이름과 전화번호 뒤 4자리로 자기 수강권을 확인합니다. 이름 철자와 공백은 수강생이 입력할 이름과 같게 넣어주세요.</p></section>';
  html += imp.memberImportHtml();
  html += bulkHtml();
  html += '<section class="panel"><h2>등록된 수강생 (' + members.length + '명)</h2>'
    + '<input id="mf-search" type="search" placeholder="이름 또는 번호로 찾기" value="' + esc(memberSearch) + '">';
  html += '<div id="mf-list">' + memberListHtml() + '</div>';
  html += '<p id="memberlist-msg" class="msg" role="status"></p></section>';
  paint(el, html, preserve);
}

/* ---------- 센세 관리 (원장) ---------- */
function renderTeachers(preserve) {
  const el = $('view-teachers');
  if (!sched) { paint(el, seedPanel(), false); return; }
  const ids = teacherIds(sched);
  const emailsOf = id => staffDocs.filter(d => d.data().role === 'teacher' && d.data().teacher === id).map(d => d.id);
  const slotsOf = id => slotList(sched).filter(s => s.teacher === id).length;
  let html = '<section class="panel"><h2>센세 목록</h2>';
  if (!ids.length) html += '<p class="empty">등록된 센세가 없습니다.</p>';
  else {
    html += '<ul class="slotlist">' + ids.map(id => {
      const emails = emailsOf(id);
      const nameCell = renaming === id
        ? '<form class="row" data-rename="' + esc(id) + '"><label>새 이름<input id="rn-name" maxlength="20" required value="' + esc(teacherName(sched, id)) + '"></label><button class="primary" type="submit">저장</button><button class="act" type="button" data-renamecancel="1">취소</button></form>'
        : '<b>' + esc(teacherName(sched, id)) + '</b>';
      return '<li><span class="info">' + nameCell
        + '<small>수업 ' + slotsOf(id) + '개 · ' + (emails.length ? emails.map(e => esc(e) + ' <button class="act" type="button" data-delemail="' + esc(e) + '" aria-label="' + esc(e) + ' 로그인 권한 삭제">×</button>').join(' ') : '로그인 계정 없음 (수강생 화면에는 표시됩니다)') + '</small></span>'
        + '<span class="btns"><button class="act" type="button" data-rename-start="' + esc(id) + '">이름 변경</button>'
        + '<button class="act' + (confirmCancel['t_' + id] ? ' danger' : '') + '" type="button" data-delteacher="' + esc(id) + '">' + (confirmCancel['t_' + id] ? '삭제 확인' : '삭제') + '</button></span></li>';
    }).join('') + '</ul>';
  }
  html += '<p id="teacher-msg" class="msg" role="status"></p></section>';

  html += '<section class="panel"><h2>센세 추가</h2><form id="teacher-form" class="row" autocomplete="off">'
    + '<label>이름<input id="tf-name" maxlength="20" required placeholder="예: 예리센세"></label>'
    + '<label>구글 이메일 (선택)<input id="tf-email" type="email" placeholder="로그인해야 하는 센세만"></label>'
    + '<button class="primary" type="submit">추가</button></form>'
    + '<p class="hint">이메일을 넣으면 그 계정으로 로그인했을 때 본인 수업의 예약자만 볼 수 있습니다. 이메일 없이도 수강생 화면에는 이름이 나옵니다.</p></section>';

  if (ids.length) {
    html += '<section class="panel"><h2>센세 로그인 계정 추가</h2><form id="email-form" class="row" autocomplete="off">'
      + '<label>센세<select id="ef-teacher">' + ids.map(id => '<option value="' + esc(id) + '">' + esc(teacherName(sched, id)) + '</option>').join('') + '</select></label>'
      + '<label>구글 이메일<input id="ef-email" type="email" required></label>'
      + '<button class="primary" type="submit">추가</button></form>'
      + '<p id="email-msg" class="msg" role="status"></p></section>';
  }

  const admins = staffDocs.filter(d => d.data().role === 'admin').map(d => d.id);
  html += '<section class="panel"><h2>관리자 계정</h2><p class="hint">관리자는 전체 수업과 예약자를 보고, 수업과 센세를 관리하고, 예약을 취소할 수 있습니다. ' + esc(ADMIN_EMAIL) + ' 는 항상 관리자입니다.</p>'
    + '<ul class="stafflist">' + (admins.length ? admins.map(e => '<li><span>' + esc(e) + '</span><button class="act" type="button" data-delemail="' + esc(e) + '">삭제</button></li>').join('') : '<li><small>추가로 등록한 관리자가 없습니다.</small></li>') + '</ul>'
    + '<form id="admin-form" class="row" autocomplete="off"><label>관리자 구글 이메일<input id="af-email" type="email" required></label><span></span><button class="primary" type="submit">추가</button></form>'
    + '<p id="admin-msg" class="msg" role="status"></p></section>';
  paint(el, html, preserve);
}

async function addTeacher(name, email) {
  const next = clone(sched); const id = newId('t');
  next.teachers[id] = { name };
  await setDoc(doc(db, 'config', 'schedule'), next);
  if (email) await setDoc(doc(db, 'staff', email), { role: 'teacher', teacher: id });
}
async function removeTeacher(id) {
  if (slotList(sched).some(s => s.teacher === id)) return setMsg('teacher-msg', false, '이 센세가 맡은 수업이 있어서 삭제할 수 없습니다. 먼저 수업을 삭제하거나 다른 센세로 바꿔주세요.');
  try {
    const next = clone(sched); delete next.teachers[id];
    await setDoc(doc(db, 'config', 'schedule'), next);
    for (const d of staffDocs.filter(x => x.data().role === 'teacher' && x.data().teacher === id)) await deleteDoc(doc(db, 'staff', d.id));
    delete confirmCancel['t_' + id];
    setMsg('teacher-msg', true, '삭제했습니다.');
  } catch (err) { setMsg('teacher-msg', false, '삭제하지 못했습니다.'); }
}

/* ---------- 전체 화면 ---------- */
function renderAll(preserve) {
  if (!role) return;
  $('tabs').hidden = role !== 'admin';
  $('purge').hidden = role !== 'admin';
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.view === view));
  $('view-bookings').hidden = view !== 'bookings';
  $('view-schedule').hidden = view !== 'schedule' || role !== 'admin';
  $('view-teachers').hidden = view !== 'teachers' || role !== 'admin';
  $('view-members').hidden = view !== 'members' || role !== 'admin';
  if (view === 'bookings') renderBookings();
  else if (role === 'admin' && view === 'schedule') renderSchedule(preserve);
  else if (role === 'admin' && view === 'teachers') renderTeachers(preserve);
  else if (role === 'admin' && view === 'members') renderMembers(preserve);
}

function startData() {
  stopData();
  unsubSched = onSnapshot(doc(db, 'config', 'schedule'), snap => {
    sched = snap.exists() ? snap.data() : null; schedLoaded = true; updateWho(); renderAll(true);
  }, () => { schedLoaded = true; showNotice('시간표를 불러오지 못했습니다.'); renderAll(true); });
  const base = collection(db, 'bookings');
  const q = role === 'admin' ? query(base, where('date', '>=', shiftMonth(thisMonth, -2) + '-01')) : query(base, where('teacher', '==', myTeacher));
  unsubBookings = onSnapshot(q, snap => {
    bookings = snap.docs.map(d => ({ id: d.id, ...d.data() })); showNotice(''); renderAll(true);
  }, () => showNotice('예약 목록을 불러오지 못했습니다. 권한이나 설정을 확인해주세요.'));
  unsubTopics = onSnapshot(query(collection(db, 'topics'), where('date', '>=', shiftMonth(thisMonth, -2) + '-01')), snap => {
    const m = {}; snap.docs.forEach(d => { const v = d.data(); if (v.text) m[d.id] = v.text; }); topics = m; renderAll(true);
  }, () => {});
  if (role === 'admin') {
    unsubStaff = onSnapshot(collection(db, 'staff'), snap => { staffDocs = snap.docs; renderAll(true); }, () => {});
    unsubMembers = onSnapshot(collection(db, 'members'), snap => { members = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderAll(true); }, () => showNotice('수강생 목록을 불러오지 못했습니다. 규칙 게시를 확인해주세요.'));
  }
}
function stopData() {
  [unsubSched, unsubBookings, unsubStaff, unsubMembers, unsubTopics].forEach(u => { if (u) u(); });
  unsubSched = unsubBookings = unsubStaff = unsubMembers = null;
}

async function resolveRole(user) {
  const email = (user.email || '').toLowerCase();
  if (email && email === ADMIN_EMAIL.toLowerCase()) return { role: 'admin' };
  const snap = await getDoc(doc(db, 'staff', email));
  if (!snap.exists()) return null;
  const v = snap.data();
  return v.role === 'admin' ? { role: 'admin' } : { role: 'teacher', teacher: v.teacher };
}

onAuthStateChanged(auth, async user => {
  stopData();
  role = myTeacher = null; bookings = []; staffDocs = []; members = []; sched = null; schedLoaded = false;
  if (!user || user.isAnonymous) { $('app').hidden = true; $('login').hidden = false; return; }
  $('login').hidden = true;
  let r = null;
  try { r = await resolveRole(user); } catch (e) { r = null; }
  if (!r) {
    $('app').hidden = true; $('login').hidden = false;
    $('login-msg').className = 'msg err';
    $('login-msg').textContent = (user.email || '이 계정') + '은(는) 등록되지 않았습니다. 원장님께 이메일 등록을 요청해주세요.';
    await signOut(auth); return;
  }
  role = r.role; myTeacher = r.teacher || null; view = 'bookings'; editing = null;
  $('app').hidden = false;
  startData(); // 센세 이름은 시간표를 받은 뒤 상단에 표시
  userEmail = user.email || ''; updateWho();
  renderAll(false);
});

$('signin').addEventListener('click', async () => {
  $('login-msg').className = 'msg'; $('login-msg').textContent = '';
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) { $('login-msg').className = 'msg err'; $('login-msg').textContent = '로그인하지 못했습니다. 팝업 차단을 풀고 다시 눌러주세요.'; }
});
$('signout').addEventListener('click', () => signOut(auth));

const imp = initImport({
  db, fs: { doc, writeBatch, setDoc, increment, getDoc },
  getMembers: () => members, getSched: () => sched, getBookings: () => bookings,
  rerender: () => renderAll(true),
  callAI: payload => httpsCallable(getFunctions(app, 'asia-northeast3'), 'readDocument', { timeout: 120000 })(payload).then(r => r.data)
});

/* ---------- 이벤트 ---------- */
document.addEventListener('click', async e => {
  const tsv = e.target.closest('[data-topic-save]');
  if (tsv) {
    const [date, slotId] = tsv.dataset.topicSave.split('|'), id = key(date, slotId);
    const inp = document.getElementById('tp_' + id), text = inp.value.trim().slice(0, 60);
    tsv.disabled = true;
    try {
      if (text) await setDoc(doc(db, 'topics', id), { date, slot: slotId, text, by: userEmail, at: Date.now() });
      else await deleteDoc(doc(db, 'topics', id));
      tsv.textContent = text ? '저장됨 ✓' : '지움 ✓';
      setTimeout(() => { tsv.textContent = '저장'; }, 1500);
    } catch (err) { alert('저장하지 못했습니다. 이 수업의 담당 센세·관리자만 입력할 수 있어요.'); }
    tsv.disabled = false; return;
  }
  const pick = e.target.closest('[data-pick]');
  if (pick) { openDate = pick.dataset.pick; openSlot = null; renderAll(false); return; }
  const tab = e.target.closest('[data-view]');
  if (tab) { view = tab.dataset.view; renderAll(false); return; }
  const ch = e.target.closest('[data-teacher]');
  if (ch) { filterTeacher = ch.dataset.teacher; openSlot = null; renderAll(false); return; }
  const nv = e.target.closest('[data-nav]');
  if (nv && !nv.disabled) { viewMonth = shiftMonth(viewMonth, +nv.dataset.nav); openDate = openSlot = null; renderAll(false); return; }
  const t = e.target.closest('[data-toggle]');
  if (t) { openDate = openDate === t.dataset.toggle ? null : t.dataset.toggle; openSlot = null; renderAll(false); return; }
  const s = e.target.closest('[data-slot]');
  if (s) { openSlot = openSlot === s.dataset.slot ? null : s.dataset.slot; renderAll(false); return; }

  if (e.target.closest('#seed-btn')) {
    try { await setDoc(doc(db, 'config', 'schedule'), SEED); } catch (err) { setMsg('seed-msg', false, '만들지 못했습니다. 규칙 게시와 관리자 이메일을 확인해주세요.'); }
    return;
  }
  if (e.target.closest('#seed-replace')) {
    if (!confirmCancel.seedreplace) { confirmCancel.seedreplace = true; renderSchedule(true); return; }
    delete confirmCancel.seedreplace;
    const next = clone(sched); next.teachers = next.teachers || {};
    const idMap = {};
    Object.keys(SEED.teachers).forEach(id => {
      const name = SEED.teachers[id].name;
      const found = Object.keys(next.teachers).find(t => next.teachers[t].name === name);
      if (found) idMap[id] = found;
      else { const nid = next.teachers[id] ? newId('t') : id; next.teachers[nid] = { name }; idMap[id] = nid; }
    });
    next.slots = {};
    Object.keys(SEED.slots).forEach(id => { const sl = Object.assign({}, SEED.slots[id]); sl.teacher = idMap[sl.teacher]; next.slots[id] = sl; });
    try { await setDoc(doc(db, 'config', 'schedule'), next); renderSchedule(false); setMsg('seedreplace-msg', true, SEED_LABEL + ' 시간표로 바꿨습니다. (수업 ' + Object.keys(next.slots).length + '개)'); }
    catch (err) { renderSchedule(false); setMsg('seedreplace-msg', false, '바꾸지 못했습니다. 잠시 후 다시 시도해주세요.'); }
    return;
  }
  if (e.target.closest('#cap-auto')) {
    if (!confirmCancel.capauto) { confirmCancel.capauto = true; renderSchedule(true); return; }
    delete confirmCancel.capauto;
    const next = clone(sched); let changed = 0;
    Object.keys(next.slots).forEach(id => { const sl = next.slots[id], c = defaultCap(sl.start, sl.end); if (sl.cap !== c) { sl.cap = c; changed++; } });
    try { await setDoc(doc(db, 'config', 'schedule'), next); renderSchedule(false); setMsg('capauto-msg', true, changed ? changed + '개 수업의 정원을 바꿨습니다.' : '이미 모두 기준에 맞습니다.'); }
    catch (err) { renderSchedule(false); setMsg('capauto-msg', false, '저장하지 못했습니다.'); }
    return;
  }
  if (e.target.closest('#slot-new')) { editing = 'new'; renderSchedule(false); const f = $('sf-name'); if (f) { f.scrollIntoView({ block: 'center' }); f.focus(); } return; }
  if (e.target.closest('#slot-cancel')) { editing = null; renderSchedule(false); return; }
  const es = e.target.closest('[data-editslot]');
  if (es) { editing = es.dataset.editslot; renderSchedule(false); const f = document.querySelector('#view-schedule li.editing'); if (f) f.scrollIntoView({ block: 'center' }); return; }
  const ds = e.target.closest('[data-delslot]');
  if (ds) {
    const id = ds.dataset.delslot;
    if (!confirmCancel['slot_' + id]) { confirmCancel['slot_' + id] = true; renderSchedule(true); return; }
    await deleteSlot(id); return;
  }
  const rs = e.target.closest('[data-rename-start]');
  if (rs) { renaming = rs.dataset.renameStart; renderTeachers(false); return; }
  if (e.target.closest('[data-renamecancel]')) { renaming = null; renderTeachers(false); return; }
  const dt = e.target.closest('[data-delteacher]');
  if (dt) {
    const id = dt.dataset.delteacher;
    if (!confirmCancel['t_' + id]) { confirmCancel['t_' + id] = true; renderTeachers(true); return; }
    await removeTeacher(id); return;
  }
  const de = e.target.closest('[data-delemail]');
  if (de) {
    try { await deleteDoc(doc(db, 'staff', de.dataset.delemail)); } catch (err) { setMsg('teacher-msg', false, '삭제하지 못했습니다.'); }
    return;
  }
  const c = e.target.closest('[data-cancel]');
  if (c && role === 'admin') { confirmCancel[c.dataset.cancel] = true; renderBookings(); return; }
  const ab = e.target.closest('[data-cancel-abort]');
  if (ab) { delete confirmCancel[ab.dataset.cancelAbort]; renderBookings(); return; }
  const cr = e.target.closest('[data-cancel-refund],[data-cancel-keep]');
  if (cr && role === 'admin') {
    const refund = cr.dataset.cancelRefund != null;
    const b = bookings.find(x => x.id === (cr.dataset.cancelRefund || cr.dataset.cancelKeep)); if (!b) return;
    const k = key(b.date, b.slot);
    try { feedback[k] = { ok: true, text: await adminCancel(b, refund) }; delete confirmCancel[b.id]; }
    catch (err) { feedback[k] = { ok: false, text: '취소하지 못했습니다. 잠시 후 다시 시도해주세요.' }; }
    renderBookings(); return;
  }

  // 수강생 관리
  const em = e.target.closest('[data-editmember]');
  if (em) { editingMember = em.dataset.editmember; renderMembers(false); return; }
  if (e.target.closest('#member-edit-cancel')) { editingMember = null; renderMembers(false); return; }
  if (e.target.closest('#bulk-preview')) {
    bulkState = parseBulk($('bulk-text').value);
    renderMembers(true);
    return;
  }
  if (e.target.closest('#bulk-go')) {
    if (!bulkState || !bulkState.rows.length) return;
    const btn = $('bulk-go'); if (btn) btn.disabled = true;
    try {
      const have = new Set(members.map(m => m.id)); const todo = []; let skipped = 0;
      for (const r of bulkState.rows) {
        const id = await memberKey(r.name, r.last4);
        if (have.has(id)) { skipped++; continue; }
        have.add(id); todo.push([id, r]);
      }
      for (let i = 0; i < todo.length; i += 400) {
        const batch = writeBatch(db);
        todo.slice(i, i + 400).forEach(([id, r]) => batch.set(doc(db, 'members', id), { name: r.name, last4: r.last4, start: r.start, end: r.end, credits: r.credits, total: r.credits, lastRef: '' }));
        await batch.commit();
      }
      bulkState = { rows: [], errs: [], warns: [], result: todo.length + '명을 등록했습니다.' + (skipped ? ' (이미 등록된 ' + skipped + '명은 건너뛰었어요. 기간이나 횟수 수정은 아래 목록에서 해주세요.)' : '') };
      const ta = $('bulk-text'); if (ta) ta.value = '';
    } catch (err) {
      bulkState.errs = ['등록하지 못했습니다. 규칙 게시와 로그인 상태를 확인해주세요.'];
    }
    renderMembers(true);
    return;
  }
  const dm = e.target.closest('[data-delmember]');
  if (dm) {
    const id = dm.dataset.delmember;
    if (!confirmCancel['m_' + id]) { confirmCancel['m_' + id] = true; renderMembers(true); return; }
    try { await deleteDoc(doc(db, 'members', id)); delete confirmCancel['m_' + id]; setMsg('memberlist-msg', true, '삭제했습니다. (이미 들어간 예약은 그대로 남습니다)'); }
    catch (err) { setMsg('memberlist-msg', false, '삭제하지 못했습니다.'); }
    return;
  }
});

// 예약 취소. refund 이면 수강생의 횟수를 1회 돌려줍니다.
async function adminCancel(b, refund) {
  const batch = writeBatch(db);
  batch.delete(doc(db, 'seats', b.id)); batch.delete(doc(db, 'bookings', b.id)); batch.delete(doc(db, 'once', b.onceKey));
  const mid = b.memberId || await memberKey(b.name, b.last4);
  batch.delete(doc(db, 'members', mid, 'mine', b.id)); // 수강생 화면용 사본 (없어도 괜찮음)
  let text = '예약을 취소했습니다.';
  if (refund) {
    const mk = b.memberId || await memberKey(b.name, b.last4);
    if (members.some(m => m.id === mk)) { batch.update(doc(db, 'members', mk), { credits: increment(b.cost || 1), lastRef: b.id }); text += ' 횟수 ' + (b.cost || 1) + '회를 돌려줬습니다.'; }
    else text += ' (등록된 수강생을 찾지 못해 횟수는 그대로입니다.)';
  } else text += ' 횟수는 차감된 채로 유지됩니다.';
  await batch.commit();
  return text;
}

// 종료된 지 3개월이 지난 수업과 오래된 시간표 백업을 정리합니다. (3개월 이내 것은 지난 예약을 보기 위해 남김)
async function cleanOldSlots(cutoff) {
  let removed = 0;
  if (sched && sched.slots) {
    const dead = Object.keys(sched.slots).filter(id => sched.slots[id].to && sched.slots[id].to < cutoff && !bookings.some(b => b.slot === id));
    if (dead.length) { const next = clone(sched); dead.forEach(id => { delete next.slots[id]; }); await setDoc(doc(db, 'config', 'schedule'), next); removed = dead.length; }
  }
  const cs = await getDocs(collection(db, 'config'));
  const stamp = cutoff.replace(/-/g, '');
  const olds = cs.docs.filter(d => /^backup_\d{12}$/.test(d.id) && d.id.slice(7, 15) < stamp);
  for (const d of olds) await deleteDoc(d.ref);
  return removed;
}
async function purgeOld() {
  const cutoff = shiftMonth(today.slice(0, 7), -3) + today.slice(7); // 오늘 기준 3개월 전 같은 날
  setMsg('purge-msg', true, '확인 중입니다…');
  try {
    const snap = await getDocs(query(collection(db, 'bookings'), where('date', '<', cutoff)));
    const msnap = await getDocs(query(collection(db, 'members'), where('end', '<', cutoff)));
    for (let i = 0; i < msnap.docs.length; i += 400) {
      const mb = writeBatch(db);
      msnap.docs.slice(i, i + 400).forEach(d => mb.delete(d.ref));
      await mb.commit();
    }
    const oldSlots = await cleanOldSlots(cutoff);
    if (snap.empty) return setMsg('purge-msg', true, oldSlots && msnap.empty ? '종료된 지난 시간표 ' + oldSlots + '개를 정리했습니다.' : msnap.empty ? '삭제할 예약과 수강생이 없습니다.' : '수강 기간이 끝난 수강생 ' + msnap.docs.length + '명을 삭제했습니다. 삭제할 예약은 없습니다.');
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 100) {
      const batch = writeBatch(db);
      docs.slice(i, i + 100).forEach(d => {
        batch.delete(doc(db, 'seats', d.id)); batch.delete(doc(db, 'bookings', d.id));
        if (d.data().onceKey) batch.delete(doc(db, 'once', d.data().onceKey));
        if (d.data().memberId) batch.delete(doc(db, 'members', d.data().memberId, 'mine', d.id));
      });
      await batch.commit();
    }
    setMsg('purge-msg', true, '예약 ' + docs.length + '건과 수강 기간이 끝난 수강생 ' + msnap.docs.length + '명을 삭제했습니다. (' + cutoff + ' 이전)');
  } catch (err) { setMsg('purge-msg', false, '삭제하지 못했습니다. 잠시 후 다시 시도해주세요.'); }
}
document.addEventListener('click', e => { if (e.target.closest('#purge-btn')) purgeOld(); });

document.addEventListener('change', e => {
  if (e.target.id === 'sf-start' || e.target.id === 'sf-end') {
    const st = $('sf-start').value, en = $('sf-end').value;
    const h = $('sf-caphint'); if (h) h.textContent = capHint(st, en);
    if (editing === 'new' && st && en && st < en) $('sf-cap').value = defaultCap(st, en);
  }
});

document.addEventListener('input', e => {
  if (e.target.id === 'mf-search') {
    // 검색칸은 다시 그리지 않고 목록만 바꿉니다. (칸을 다시 그리면 한글 조합이 끊겨 'ㅇ ㅣ ㅈ ㅣ'처럼 풀립니다.)
    memberSearch = e.target.value;
    const box = $('mf-list'); if (box) box.innerHTML = memberListHtml();
  }
});

document.addEventListener('submit', async e => {
  const f = e.target;
  if (f.id === 'member-form') {
    e.preventDefault();
    const name = $('mn-name').value.trim(), last4 = $('mn-last4').value.trim();
    const start = $('mn-start').value, end = $('mn-end').value, credits = parseInt($('mn-credits').value, 10);
    if (!name) return setMsg('member-msg', false, '이름을 입력해주세요.');
    if (!/^[0-9]{4}$/.test(last4)) return setMsg('member-msg', false, '전화번호 뒤 4자리를 숫자로 입력해주세요.');
    if (!start || !end || start > end) return setMsg('member-msg', false, '수강 종료일이 시작일보다 빠를 수 없습니다.');
    if (!(credits >= 1 && credits <= 999)) return setMsg('member-msg', false, '횟수는 1 이상으로 입력해주세요.');
    try {
      const id = await memberKey(name, last4);
      if (members.some(m => m.id === id)) return setMsg('member-msg', false, '이미 등록된 수강생입니다. 아래 목록에서 수정해주세요.');
      await setDoc(doc(db, 'members', id), { name, last4, start, end, credits, total: credits, lastRef: '' });
      ['mn-name', 'mn-last4', 'mn-end', 'mn-credits'].forEach(x => { $(x).value = ''; });
      setMsg('member-msg', true, name + '님을 등록했습니다.');
    } catch (err) { setMsg('member-msg', false, '등록하지 못했습니다. 규칙 게시와 로그인 상태를 확인해주세요.'); }
    return;
  }
  if (f.id === 'member-edit-form') {
    e.preventDefault();
    const start = $('me-start').value, end = $('me-end').value;
    const add = parseInt($('me-add').value || '0', 10) || 0;
    let credits = parseInt($('me-credits').value, 10), total = parseInt($('me-total').value, 10);
    if (!start || !end || start > end) return setMsg('member-edit-msg', false, '수강 종료일이 시작일보다 빠를 수 없습니다.');
    if (!(credits >= 0) || !(total >= 0) || add < 0) return setMsg('member-edit-msg', false, '횟수는 0 이상 숫자로 입력해주세요.');
    credits += add; total += add;
    if (credits > total) return setMsg('member-edit-msg', false, '남은 횟수가 총 횟수보다 클 수 없습니다.');
    const name = $('me-name').value.trim().replace(/\s+/g, ' '), last4 = $('me-last4').value.trim();
    if (!name) return setMsg('member-edit-msg', false, '이름을 입력해주세요.');
    if (!/^[0-9]{4}$/.test(last4)) return setMsg('member-edit-msg', false, '전화번호 뒤 4자리를 숫자로 입력해주세요.');
    const submitBtn = f.querySelector('button[type=submit]'); if (submitBtn) submitBtn.disabled = true;
    try {
      const oldId = editingMember, newId = await memberKey(name, last4);
      if (newId === oldId) {
        await updateDoc(doc(db, 'members', oldId), { name, last4, start, end, credits, total });
      } else {
        if (members.some(m => m.id === newId)) { if (submitBtn) submitBtn.disabled = false; return setMsg('member-edit-msg', false, '같은 이름·번호의 수강생이 이미 등록되어 있습니다.'); }
        const old = members.find(m => m.id === oldId);
        const snap = await getDocs(query(collection(db, 'bookings'), where('memberId', '==', oldId)));
        if (snap.size > 150) { if (submitBtn) submitBtn.disabled = false; return setMsg('member-edit-msg', false, '이 수강생의 예약이 너무 많아 한 번에 옮길 수 없습니다. 지난 예약을 정리한 뒤 다시 시도해주세요.'); }
        const batch = writeBatch(db);
        batch.set(doc(db, 'members', newId), { name, last4, start, end, credits, total, lastRef: (old && old.lastRef) || '' });
        snap.docs.forEach(d => {
          const b = d.data();
          batch.update(d.ref, { memberId: newId, name, last4 });
          batch.set(doc(db, 'members', newId, 'mine', d.id), { date: b.date, slot: b.slot, n: b.n, onceKey: b.onceKey, cost: b.cost || 1, name, uid: b.uid, at: b.at });
          batch.delete(doc(db, 'members', oldId, 'mine', d.id));
        });
        batch.delete(doc(db, 'members', oldId));
        await batch.commit();
      }
      editingMember = null; renderMembers(false); setMsg('memberlist-msg', true, '저장했습니다.');
    } catch (err) { if (submitBtn) submitBtn.disabled = false; setMsg('member-edit-msg', false, '저장하지 못했습니다. 규칙 게시와 로그인 상태를 확인해주세요.'); }
    return;
  }
  if (f.id === 'cap-form') {
    e.preventDefault();
    const next = clone(sched); let changed = 0;
    for (const inp of f.querySelectorAll('input[data-capname]')) {
      const raw = inp.value.trim(); if (raw === '') continue;
      const cap = parseInt(raw, 10), name = inp.dataset.capname;
      if (!(cap >= 1 && cap <= 30)) return setMsg('cap-msg', false, '정원은 1~30명으로 입력해주세요.');
      Object.keys(next.slots).forEach(id => { if (next.slots[id].name === name && next.slots[id].cap !== cap) { next.slots[id].cap = cap; changed++; } });
    }
    if (!changed) return setMsg('cap-msg', true, '바뀐 정원이 없습니다.');
    try { await setDoc(doc(db, 'config', 'schedule'), next); setMsg('cap-msg', true, '정원을 저장했습니다. (' + changed + '개 시간대)'); }
    catch (err) { setMsg('cap-msg', false, '저장하지 못했습니다.'); }
    return;
  }
  if (f.id === 'slot-form') { e.preventDefault(); await saveSlot(); return; }
  if (f.id === 'teacher-form') {
    e.preventDefault();
    const name = $('tf-name').value.trim(), email = $('tf-email').value.trim().toLowerCase();
    if (!name) return setMsg('teacher-msg', false, '이름을 입력해주세요.');
    if (email && !isEmail(email)) return setMsg('teacher-msg', false, '이메일 형식이 올바르지 않습니다.');
    try { await addTeacher(name, email); $('tf-name').value = ''; $('tf-email').value = ''; setMsg('teacher-msg', true, name + ' 센세를 추가했습니다.'); }
    catch (err) { setMsg('teacher-msg', false, '추가하지 못했습니다.'); }
    return;
  }
  if (f.id === 'email-form') {
    e.preventDefault();
    const email = $('ef-email').value.trim().toLowerCase(), teacher = $('ef-teacher').value;
    if (!isEmail(email)) return setMsg('email-msg', false, '이메일 형식이 올바르지 않습니다.');
    try { await setDoc(doc(db, 'staff', email), { role: 'teacher', teacher }); $('ef-email').value = ''; setMsg('email-msg', true, '로그인 계정을 추가했습니다.'); }
    catch (err) { setMsg('email-msg', false, '추가하지 못했습니다.'); }
    return;
  }
  if (f.id === 'admin-form') {
    e.preventDefault();
    const email = $('af-email').value.trim().toLowerCase();
    if (!isEmail(email)) return setMsg('admin-msg', false, '이메일 형식이 올바르지 않습니다.');
    try { await setDoc(doc(db, 'staff', email), { role: 'admin' }); $('af-email').value = ''; setMsg('admin-msg', true, '관리자를 추가했습니다.'); }
    catch (err) { setMsg('admin-msg', false, '추가하지 못했습니다.'); }
    return;
  }
  if (f.dataset && f.dataset.rename) {
    e.preventDefault();
    const name = $('rn-name').value.trim(); if (!name) return;
    const next = clone(sched); next.teachers[f.dataset.rename].name = name;
    try { await setDoc(doc(db, 'config', 'schedule'), next); renaming = null; renderTeachers(false); }
    catch (err) { setMsg('teacher-msg', false, '이름을 바꾸지 못했습니다.'); }
  }
});
