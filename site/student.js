import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, query, where, onSnapshot, writeBatch, serverTimestamp, increment }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import {
  DOW, DOW_ORDER, MAX_AHEAD, slotsFor, slotList, teachersWithSlots, teacherName,
  kstToday, kstNowHM, addDays, weekKey, shiftMonth, parseDate, esc,
  memberKey, passInfo, PASS_STATE, dotDate, canCancel, CANCEL_HOURS, slotCost, isOpenDate, opensOn
} from "./schedule.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const today = kstToday();
const thisWeek = weekKey(today);
const lastWeek = weekKey(shiftMonth(today.slice(0, 7), MAX_AHEAD) + '-01'); // 이 주까지만 넘겨볼 수 있음
let weekStart = thisWeek;
let selDate = today;
let uid = null;
let sched = null, schedLoaded = false;
let teacherFilter = 'all', timeFilter = 'all', classFilter = 'all', showFull = true;
let openSlot = null;
let taken = {};      // "날짜_수업" -> Set(좌석번호)
let topics = {};     // 이날의 수업 주제 { '날짜_수업': '글' }
let mine = [];       // 내 예약 (이름+번호로 확인한 수강생의 예약, 어느 기기에서든)
let mineMirror = [], mineLegacy = [];
const feedback = {}; // "날짜_수업" -> {ok,text}
const confirmCancel = {};
const LOW_LEFT = 2;  // 남은 자리가 이 숫자 이하일 때만 학생에게 남은 자리를 보여줍니다. (정원은 보여주지 않음)

// 수강권 확인(이름 + 전화번호 뒤 4자리). 이 기기에 기억해 둡니다.
let ident = null;                 // {name, last4}
let identKey = null;              // members 문서 이름
let member = null;                // 수강권 문서 내용
let memberStatus = 'none';        // none | loading | ok | missing | error
let memberMsg = '';
let unsubMember = null;
const IDENT_STORE = 'yeri.ident';
try { const raw = localStorage.getItem(IDENT_STORE); if (raw) { const v = JSON.parse(raw); if (v && v.name && /^[0-9]{4}$/.test(v.last4)) ident = { name: String(v.name), last4: v.last4 }; } } catch (e) { /* 저장소를 못 써도 동작함 */ }
function saveIdent() { try { if (ident) localStorage.setItem(IDENT_STORE, JSON.stringify(ident)); else localStorage.removeItem(IDENT_STORE); } catch (e) { /* 무시 */ } }

const $ = id => document.getElementById(id);
const key = (date, slot) => date + '_' + slot;
const countOf = (date, slot) => (taken[key(date, slot)] || new Set()).size;
const myBookings = (date, slot) => mine.filter(b => b.date === date && b.slot === slot);
const bucket = start => { const h = +start.slice(0, 2); return h < 12 ? 'am' : (h < 18 ? 'pm' : 'eve'); };
const TIME_LABEL = { all: '전체', am: '오전 (12시 전)', pm: '오후 (12~18시)', eve: '저녁 (18시 이후)' };

function showNotice(t) { const n = $('notice'); n.textContent = t; n.hidden = !t; }

async function hash(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

const isEnded = (date, slot) => date < today || (date === today && slot.end <= kstNowHM());
function passes(slot) {
  if (teacherFilter !== 'all' && slot.teacher !== teacherFilter) return false;
  if (classFilter !== 'all' && slot.name !== classFilter) return false;
  if (timeFilter !== 'all' && bucket(slot.start) !== timeFilter) return false;
  return true;
}
function visibleSlots(date) {
  const dow = parseDate(date).getUTCDay();
  return slotsFor(sched, dow, null, date).filter(passes).filter(s => {
    if (showFull) return true;
    return countOf(date, s.id) < s.cap || myBookings(date, s.id).length > 0;
  });
}

/* ---------- 수강권 ---------- */
function renderMember() {
  const el = $('member');
  const consent = '<p class="consent">이름과 전화번호 뒤 4자리는 수강권 확인과 수업 예약에만 사용합니다.</p>';
  if (!ident) {
    el.innerHTML = '<div class="pass"><div class="pass-top"><span class="pass-badge">내 수강권</span></div>'
      + '<div class="pass-card"><h2>수강권 확인</h2>'
      + '<p class="hint">학원에 등록한 이름과 전화번호 뒤 4자리를 입력하면 수강 기간과 남은 횟수를 볼 수 있고, 수업을 예약할 수 있어요.</p>'
      + '<form id="member-form" class="row" autocomplete="off">'
      + '<label>이름<input id="mf-name" name="name" maxlength="20" required></label>'
      + '<label>전화번호 뒤 4자리<input id="mf-last4" name="last4" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></label>'
      + '<button class="primary" type="submit">확인</button></form>'
      + '<p class="msg' + (memberMsg ? ' err' : '') + '" role="status">' + esc(memberMsg) + '</p>' + consent + '</div></div>';
    return;
  }
  if (memberStatus === 'loading' || memberStatus === 'none') {
    el.innerHTML = '<div class="pass"><div class="pass-top"><span class="pass-badge">내 수강권</span></div><div class="pass-card"><p class="hint">수강권을 불러오는 중입니다…</p></div></div>';
    return;
  }
  if (memberStatus !== 'ok' || !member) {
    const text = memberStatus === 'error' ? '수강권을 불러오지 못했습니다. 잠시 후 새로고침해주세요.'
      : '등록된 수강생을 찾지 못했습니다. 이름과 전화번호 뒤 4자리를 다시 확인하시고, 계속 안 되면 학원에 문의해주세요.';
    el.innerHTML = '<div class="pass"><div class="pass-top"><span class="pass-badge">내 수강권</span></div><div class="pass-card"><p class="msg err">' + esc(text) + '</p>'
      + '<div><button id="member-reset" class="act" type="button">다시 입력</button></div></div></div>';
    return;
  }
  const info = passInfo(member, today);
  const leftText = info.state === 'before' ? (Math.round((parseDate(member.start) - parseDate(today)) / 86400000)) + '일 후 시작'
    : (info.state === 'expired' ? '기간 만료' : info.left + '일 남음');
  const credits = Math.max(0, member.credits || 0);
  el.innerHTML = '<div class="pass"><div class="pass-top"><span class="pass-badge">내 수강권</span>'
    + '<span class="pass-state s-' + info.state + '">' + PASS_STATE[info.state] + '</span>'
    + '<button id="member-reset" class="pass-link" type="button">다른 이름으로 보기</button></div>'
    + '<div class="pass-card"><small>자율출석 회화반 수강권</small><h2>' + esc(member.name) + '님</h2>'
    + '<p class="pass-period">' + dotDate(member.start) + ' – ' + dotDate(member.end) + '</p>'
    + '<div class="pass-rows">'
    + '<div><span>잔여 일수</span><b><em>' + leftText + '</em>' + (info.state === 'active' || info.state === 'empty' ? ' / 총 ' + info.total + '일' : '') + '</b></div>'
    + '<div><span>잔여 횟수</span><b><em>' + credits + '회</em> / 총 ' + (member.total || 0) + '회</b></div>'
    + '</div></div></div>';
}

// 이 날짜에 수강권으로 예약할 수 있는지 (불가하면 이유를 돌려줌)
function passProblem(date, cost) {
  cost = cost || 1;
  if (!ident) return '먼저 위에서 수강권을 확인해주세요.';
  if (memberStatus === 'loading' || memberStatus === 'none') return '수강권을 불러오는 중입니다. 잠시 후 다시 눌러주세요.';
  if (memberStatus !== 'ok' || !member) return '등록된 수강생이 아닙니다. 위에서 수강권을 다시 확인하거나 학원에 문의해주세요.';
  if (date < member.start || date > member.end) return '수강 기간(' + dotDate(member.start) + ' – ' + dotDate(member.end) + ') 안의 수업만 예약할 수 있어요.';
  if ((member.credits || 0) < cost) return (member.credits || 0) < 1 ? '남은 횟수가 없습니다. 학원에 문의해주세요.' : '이 수업은 ' + cost + '회가 차감되는데 남은 횟수가 ' + (member.credits || 0) + '회예요. 학원에 문의해주세요.';
  return '';
}

/* ---------- 그리기 ---------- */
let filtersSig = '';
function renderFilters() {
  const el = $('filters');
  if (!sched) { el.hidden = true; return; }
  const teachers = teachersWithSlots(sched);
  const classes = [...new Set(slotList(sched).filter(s => !s.to || s.to >= today).map(s => s.name))].sort((a, b) => a.localeCompare(b, 'ko'));
  if (teacherFilter !== 'all' && teachers.indexOf(teacherFilter) < 0) teacherFilter = 'all';
  if (classFilter !== 'all' && classes.indexOf(classFilter) < 0) classFilter = 'all';
  el.hidden = false;
  const sig = JSON.stringify([teachers.map(id => [id, teacherName(sched, id)]), classes]);
  if (sig !== filtersSig) {
    filtersSig = sig;
    $('f-teacher').innerHTML = '<option value="all">전체</option>' + teachers.map(id => '<option value="' + esc(id) + '">' + esc(teacherName(sched, id)) + '</option>').join('');
    $('f-class').innerHTML = '<option value="all">전체</option>' + classes.map(c => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join('');
    $('f-time').innerHTML = Object.keys(TIME_LABEL).map(k => '<option value="' + k + '">' + TIME_LABEL[k] + '</option>').join('');
  }
  $('f-teacher').value = teacherFilter; $('f-class').value = classFilter; $('f-time').value = timeFilter;
}

function cancelControl(b) {
  const def = sched && sched.slots && sched.slots[b.slot];
  if (!def) return '';
  if (!canCancel(b.date, def.start)) return '<span class="locked">취소 불가 (수업 ' + CANCEL_HOURS + '시간 전 마감)</span>';
  const asking = confirmCancel[b.id];
  return '<button class="act' + (asking ? ' danger' : '') + '" type="button" data-cancel="' + esc(b.id) + '">'
    + (asking ? (b.memberId ? '취소 확인 (횟수 환불)' : '취소 확인') : '예약 취소') + '</button>';
}

function renderMine() {
  const el = $('mine');
  const upcoming = sched ? mine.filter(b => b.date >= today && sched.slots && sched.slots[b.slot]) : [];
  upcoming.sort((a, b) => (a.date + sched.slots[a.slot].start).localeCompare(b.date + sched.slots[b.slot].start));
  if (!upcoming.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = '<h2>내 예약</h2><ul class="roster">' + upcoming.map(b => {
    const s = sched.slots[b.slot], d = parseDate(b.date);
    return '<li><span class="nm">' + (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '(' + DOW[d.getUTCDay()] + ') ' + esc(s.start) + ' · ' + esc(s.name) + ' · ' + esc(teacherName(sched, s.teacher))
      + '<small>' + esc(b.name) + '</small></span>' + cancelControl(b) + '</li>';
  }).join('') + '</ul><p class="hint">취소는 수업 시작 ' + CANCEL_HOURS + '시간 전까지 가능하고, 취소하면 횟수가 돌아옵니다.</p>';
}

function renderWeek() {
  const a = parseDate(weekStart), b = parseDate(addDays(weekStart, 6));
  const same = a.getUTCMonth() === b.getUTCMonth();
  $('week-label').textContent = a.getUTCFullYear() + '년 ' + (a.getUTCMonth() + 1) + '월 ' + a.getUTCDate() + '일 – ' + (same ? '' : (b.getUTCMonth() + 1) + '월 ') + b.getUTCDate() + '일';
  $('prev').disabled = weekStart <= thisWeek;
  $('next').disabled = weekStart >= lastWeek;
  let html = '';
  DOW_ORDER.forEach((dow, i) => {
    const date = addDays(weekStart, i), d = parseDate(date);
    const has = sched ? visibleSlots(date).length > 0 : false;
    html += '<button class="daybtn' + (date === selDate ? ' on' : '') + (has ? '' : ' off') + (date === today ? ' today' : '') + '" type="button" data-day="' + date + '" aria-pressed="' + (date === selDate) + '" aria-label="' + (d.getUTCMonth() + 1) + '월 ' + d.getUTCDate() + '일 ' + DOW[dow] + '요일' + (date === today ? ' (오늘)' : '') + '">'
      + '<span class="dw">' + DOW[dow] + '</span><span class="dn">' + d.getUTCDate() + '</span></button>';
  });
  $('daystrip').innerHTML = html;
}

function renderCard(date, slot) {
  const cap = slot.cap, n = countOf(date, slot.id), full = n >= cap, left = Math.max(0, cap - n);
  const ended = isEnded(date, slot), my = myBookings(date, slot.id), k = key(date, slot.id);
  const isOpen = openSlot === slot.id, d = parseDate(date), cost = slotCost(slot);
  // 정원은 보여주지 않고, 자리가 거의 찼을 때만 남은 자리를 알려줍니다.
  const low = !ended && !full && left <= LOW_LEFT;
  const tagText = ended ? '종료된 수업' : (full ? '정원이 모두 찼어요' : (low ? '마감 임박 · 잔여 ' + left + '석' : '예약 가능'));
  const mark = (!ended && full) ? '<span class="fullmark">마감</span>' : (my.length ? '<span class="mymark">내 예약</span>' : '');
  let btn;
  if (ended) btn = '<button class="bookbtn" type="button" disabled>종료</button>';
  else if (full && !my.length) btn = '<button class="bookbtn" type="button" disabled>마감</button>';
  else if (my.length) btn = '<button class="bookbtn ghost" type="button" data-slotbtn="' + esc(slot.id) + '" aria-expanded="' + isOpen + '">내 예약 보기</button>';
  else btn = '<button class="bookbtn" type="button" data-slotbtn="' + esc(slot.id) + '" aria-expanded="' + isOpen + '">예약하기</button>';
  const tname = teacherName(sched, slot.teacher);
  let h = '<article class="card' + (ended ? ' ended' : '') + '"><div class="top"><span class="tag' + (low ? ' warn' : '') + '">' + tagText + '</span>' + (cost > 1 ? '<span class="costtag">' + cost + '회 차감</span>' : '') + mark + '</div>'
    + '<h3>' + esc(slot.name) + '</h3>'
    + '<div class="when"><span>' + (d.getUTCMonth() + 1) + '월 ' + d.getUTCDate() + '일 (' + DOW[d.getUTCDay()] + ')</span><span class="sep"></span><span>' + esc(slot.start) + ' – ' + esc(slot.end) + '</span></div>'
    + (topics[k] ? '<p class="topic"><b>이날의 주제</b>' + esc(topics[k]) + '</p>' : '')
    + '<div class="foot"><span class="teacher"><span class="avatar" aria-hidden="true">' + esc(tname.replace(/센세$/, '').charAt(0) || '?') + '</span><b>' + esc(tname) + '</b></span>' + btn + '</div>';
  if (isOpen && !(ended)) {
    h += '<div class="drawer">';
    if (my.length) {
      h += '<ul class="roster">' + my.map(b =>
        '<li><span class="nm">' + esc(b.name) + '님 예약됨</span>' + cancelControl(b) + '</li>').join('') + '</ul>';
    }
    if (!full) {
      const problem = passProblem(date, cost);
      const already = ident && myBookings(date, slot.id).some(b => member && b.memberId && b.name === member.name);
      if (already) {
        h += '<p class="hint">이미 이 수업에 예약하셨어요.</p>';
      } else if (problem) {
        h += '<p class="hint">' + esc(problem) + '</p>';
        if (!ident) h += '<div><button class="act" type="button" data-gopass="1">수강권 확인하러 가기</button></div>';
      } else {
        h += '<div class="confirmbook"><p><b>' + esc(member.name) + '</b>님으로 예약합니다.<br><small>횟수 ' + cost + '회가 차감됩니다 (잔여 ' + (member.credits || 0) + '회 → ' + ((member.credits || 0) - cost) + '회). 수업 ' + CANCEL_HOURS + '시간 전까지 취소하면 돌려받아요.</small></p>'
          + '<button class="primary" type="button" data-book="' + esc(slot.id) + '" data-bookdate="' + date + '">예약 확정</button></div>';
      }
    }
    const f = feedback[k];
    h += '<p class="msg' + (f ? (f.ok ? ' good' : ' err') : '') + '" role="status">' + (f ? esc(f.text) : '') + '</p></div>';
  }
  return h + '</article>';
}

function render() {
  // 입력 중인 글자와 커서가 다시 그리는 동안 사라지지 않게 먼저 저장합니다.
  const saved = {};
  document.querySelectorAll('#member input').forEach(i => { saved[i.id] = i.value; });
  const focusId = document.activeElement && document.activeElement.id;
  renderMember();
  renderFilters();
  renderMine();
  renderWeek();
  let html = '';
  if (!sched) {
    html = '<p class="empty">' + (schedLoaded ? '아직 수업 시간표가 등록되지 않았습니다. 학원에 문의해주세요.' : '불러오는 중입니다…') + '</p>';
  } else {
    const list = visibleSlots(selDate);
    if (!isOpenDate(selDate, today)) {
      const d = parseDate(selDate);
      html = '<div class="notopen"><b>아직 오픈되지 않은 시간표입니다</b><p>' + (d.getUTCMonth() + 1) + '월 수업은 <b>' + opensOn(selDate) + '</b>부터 예약할 수 있어요.<br>오픈되면 이 화면에서 바로 예약하실 수 있습니다.</p></div>';
    } else html = list.length ? list.map(s => renderCard(selDate, s)).join('')
      : '<p class="empty">이 날은 조건에 맞는 수업이 없습니다. 다른 날짜를 눌러보거나 필터를 바꿔보세요.</p>';
  }
  $('list').innerHTML = html;
  document.querySelectorAll('#member input').forEach(i => { if (saved[i.id] != null) i.value = saved[i.id]; });
  if (focusId) { const el = $(focusId); if (el && ($('list').contains(el) || $('member').contains(el))) el.focus(); }
}

/* ---------- 예약 ---------- */
async function reserve(date, slot) {
  const def = sched && sched.slots && sched.slots[slot];
  if (!def) return { ok: false, text: '이 수업은 더 이상 열려 있지 않습니다. 새로고침해주세요.' };
  if (isEnded(date, def)) return { ok: false, text: '이미 끝난 수업입니다.' };
  if (!isOpenDate(date, today)) return { ok: false, text: '아직 오픈되지 않은 시간표입니다. ' + opensOn(date) + '부터 예약할 수 있어요.' };
  const cost = slotCost(def);
  const problem = passProblem(date, cost);
  if (problem) return { ok: false, text: problem };
  const name = member.name, last4 = member.last4;
  const cap = def.cap, k = key(date, slot), used = taken[k] || new Set();
  const once = k + '_' + await hash(name.toLowerCase() + '|' + last4);
  if (mine.some(b => b.onceKey === once)) return { ok: false, text: '이미 이 수업에 예약되어 있습니다.' };
  const tried = new Set();
  const freeSeats = () => { const u = taken[k] || new Set(), f = []; for (let i = 1; i <= cap; i++) if (!u.has(i) && !tried.has(i)) f.push(i); return f; };
  if (!freeSeats().length) return { ok: false, text: '정원이 모두 찼습니다.' };
  // 많은 사람이 동시에 누르면 같은 좌석 번호가 겹칠 수 있어서, 실패하면 최신 빈 좌석을 다시 골라 여러 번 시도합니다.
  for (let tries = 0; tries < 8; tries++) {
    const free = freeSeats(); if (!free.length) break;
    const n = free[Math.floor(Math.random() * free.length)];
    tried.add(n);
    const id = k + '_' + n, batch = writeBatch(db);
    batch.set(doc(db, 'seats', id), { date, slot, n, uid, at: serverTimestamp() });
    batch.set(doc(db, 'bookings', id), { date, slot, n, teacher: def.teacher, name, last4, memberId: identKey, cost, uid, onceKey: once, at: serverTimestamp() });
    batch.set(doc(db, 'members', identKey, 'mine', id), { date, slot, n, onceKey: once, cost, name, uid, at: serverTimestamp() });
    batch.set(doc(db, 'once', once), { uid, date, slot });
    batch.update(doc(db, 'members', identKey), { credits: increment(-cost), lastRef: id });
    try {
      await batch.commit();
      return { ok: true, text: name + '님 예약되었습니다. 횟수 ' + cost + '회가 차감되었어요.' };
    } catch (e) {
      if (e.code === 'permission-denied' || e.code === 'aborted' || e.code === 'already-exists') { await new Promise(r => setTimeout(r, 150 + Math.random() * 350)); continue; }
      throw e;
    }
  }
  return { ok: false, text: '다른 분이 먼저 예약했거나 같은 이름으로 이미 예약된 수업입니다. 다시 확인해주세요.' };
}

async function cancelBooking(b) {
  const batch = writeBatch(db);
  batch.delete(doc(db, 'seats', b.id));
  batch.delete(doc(db, 'bookings', b.id));
  batch.delete(doc(db, 'once', b.onceKey));
  if (b.viaMirror) batch.delete(doc(db, 'members', b.memberId, 'mine', b.id));
  if (b.memberId) batch.update(doc(db, 'members', b.memberId), { credits: increment(b.cost || 1), lastRef: b.id });
  await batch.commit();
}

/* ---------- 수강권 확인 ---------- */
function recomputeMine() {
  const ids = new Set(mineMirror.map(b => b.id));
  // 예전 방식(이 기기에서 만든 예약)도 같은 수강생 것이면 함께 보여줍니다.
  mine = mineMirror.concat(mineLegacy.filter(b => b.memberId && b.memberId === identKey && !ids.has(b.id)));
  if (!identKey) mine = [];
}
let unsubMine = null;
async function startMember() {
  if (unsubMember) { unsubMember(); unsubMember = null; }
  if (unsubMine) { unsubMine(); unsubMine = null; }
  member = null; identKey = null; mineMirror = []; recomputeMine();
  if (!ident) { memberStatus = 'none'; render(); return; }
  if (!uid) { memberStatus = 'loading'; render(); return; }
  memberStatus = 'loading'; render();
  identKey = await memberKey(ident.name, ident.last4);
  const mine_key = identKey;
  unsubMine = onSnapshot(collection(db, 'members', mine_key, 'mine'), snap => {
    if (mine_key !== identKey) return;
    mineMirror = snap.docs.map(d => ({ id: d.id, memberId: mine_key, viaMirror: true, ...d.data() })); recomputeMine(); render();
  }, () => {});
  unsubMember = onSnapshot(doc(db, 'members', mine_key), snap => {
    if (mine_key !== identKey) return;
    if (snap.exists()) { member = snap.data(); memberStatus = 'ok'; }
    else { member = null; memberStatus = 'missing'; }
    render();
  }, () => { member = null; memberStatus = 'error'; render(); });
}

/* ---------- 이벤트 ---------- */
document.addEventListener('click', async e => {
  const wn = e.target.closest('[data-weeknav]');
  if (wn && !wn.disabled) {
    weekStart = addDays(weekStart, 7 * +wn.dataset.weeknav);
    selDate = (today >= weekStart && today <= addDays(weekStart, 6)) ? today : weekStart;
    openSlot = null; taken = {}; subscribeSeats(); render(); return;
  }
  const dy = e.target.closest('[data-day]');
  if (dy) { selDate = dy.dataset.day; openSlot = null; render(); return; }
  const sb = e.target.closest('[data-slotbtn]');
  if (sb) { openSlot = openSlot === sb.dataset.slotbtn ? null : sb.dataset.slotbtn; render(); return; }
  if (e.target.closest('#member-reset')) {
    ident = null; saveIdent(); memberMsg = ''; startMember(); return;
  }
  if (e.target.closest('[data-gopass]')) {
    const el = $('member'); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const inp = $('mf-name'); if (inp) inp.focus(); return;
  }
  const bk = e.target.closest('[data-book]');
  if (bk) {
    const date = bk.dataset.bookdate, slot = bk.dataset.book, k = key(date, slot);
    bk.disabled = true;
    try { feedback[k] = await reserve(date, slot); }
    catch (err) { feedback[k] = { ok: false, text: '예약을 저장하지 못했습니다. 인터넷 연결을 확인하고 다시 시도해주세요.' }; }
    render(); return;
  }
  const c = e.target.closest('[data-cancel]');
  if (c) {
    const b = mine.find(x => x.id === c.dataset.cancel); if (!b) return;
    const def = sched && sched.slots && sched.slots[b.slot];
    if (!def || !canCancel(b.date, def.start)) { feedback[key(b.date, b.slot)] = { ok: false, text: '수업 시작 ' + CANCEL_HOURS + '시간 전까지만 취소할 수 있어요. 변경이 필요하면 학원에 문의해주세요.' }; render(); return; }
    if (!confirmCancel[b.id]) { confirmCancel[b.id] = true; render(); return; }
    try { await cancelBooking(b); delete confirmCancel[b.id]; feedback[key(b.date, b.slot)] = { ok: true, text: '예약을 취소했습니다.' + (b.memberId ? ' 횟수 ' + (b.cost || 1) + '회가 돌아왔어요.' : '') }; }
    catch (err) { delete confirmCancel[b.id]; feedback[key(b.date, b.slot)] = { ok: false, text: '취소하지 못했습니다. 수업 ' + CANCEL_HOURS + '시간 이내이거나 연결이 불안정할 수 있어요. 잠시 후 다시 시도해주세요.' }; }
    render();
  }
});

document.addEventListener('change', e => {
  if (e.target.id === 'f-teacher') teacherFilter = e.target.value;
  else if (e.target.id === 'f-time') timeFilter = e.target.value;
  else if (e.target.id === 'f-class') classFilter = e.target.value;
  else if (e.target.id === 'showfull') showFull = e.target.checked;
  else return;
  openSlot = null; render();
});

document.addEventListener('submit', e => {
  const f = e.target.closest('#member-form'); if (!f) return;
  e.preventDefault();
  const name = f.elements.name.value.trim(), last4 = f.elements.last4.value.trim();
  if (!name) { memberMsg = '이름을 입력해주세요.'; render(); return; }
  if (!/^[0-9]{4}$/.test(last4)) { memberMsg = '전화번호 뒤 4자리를 숫자로 입력해주세요.'; render(); return; }
  memberMsg = ''; ident = { name, last4 }; saveIdent(); startMember();
});

render();

// 시간이 지나면 취소 가능 여부와 종료된 수업 표시가 바뀌므로 1분마다 다시 그립니다.
setInterval(() => { if (!document.hidden) render(); }, 60000);

// 보고 있는 주의 좌석만 읽어서 읽기 횟수를 줄입니다.
let unsubSeats = null, unsubTopics = null;
function subscribeSeats() {
  if (!uid) return;
  if (unsubSeats) unsubSeats();
  if (unsubTopics) unsubTopics();
  unsubTopics = onSnapshot(query(collection(db, 'topics'), where('date', '>=', weekStart), where('date', '<=', addDays(weekStart, 6))), snap => {
    const m = {}; snap.docs.forEach(d => { const v = d.data(); if (v.text) m[key(v.date, v.slot)] = v.text; }); topics = m; render();
  }, () => {});
  const q = query(collection(db, 'seats'), where('date', '>=', weekStart), where('date', '<=', addDays(weekStart, 6)));
  unsubSeats = onSnapshot(q, snap => {
    const map = {};
    snap.docs.forEach(d => { const v = d.data(); (map[key(v.date, v.slot)] = map[key(v.date, v.slot)] || new Set()).add(v.n); });
    taken = map; showNotice(''); render();
  }, () => showNotice('예약 현황을 불러오지 못했습니다. 새로고침해주세요.'));
}

onAuthStateChanged(auth, user => {
  if (!user) return;
  uid = user.uid;
  onSnapshot(doc(db, 'config', 'schedule'), snap => {
    sched = snap.exists() ? snap.data() : null; schedLoaded = true; render();
  }, () => { schedLoaded = true; showNotice('시간표를 불러오지 못했습니다. 새로고침해주세요.'); render(); });
  subscribeSeats();
  onSnapshot(query(collection(db, 'bookings'), where('uid', '==', uid)), snap => {
    mineLegacy = snap.docs.map(d => ({ id: d.id, ...d.data() })); recomputeMine(); render();
  }, () => {});
  startMember();
});
signInAnonymously(auth).catch(() => showNotice('접속하지 못했습니다. 인터넷 연결을 확인하고 새로고침해주세요.'));
