// 실제 Firebase 보안 규칙(../firestore.rules)을 내 컴퓨터의 에뮬레이터에서 그대로 실행해 보는 시험입니다.
// 1) 규칙 시험: 예약/취소/2회 차감/다른 기기 취소/20일 오픈/남의 예약 보호
// 2) 동시 접속 시험: 수강생 200명이 한꺼번에 예약하고 일부는 취소했을 때 정원/횟수가 어긋나지 않는지
import fs from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import { webcrypto } from 'node:crypto';

const FV = firebase.firestore.FieldValue;
const env = await initializeTestEnvironment({
  projectId: 'demo-yeri',
  firestore: { rules: fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') }
});

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra ?? ''); } };
const t = async (name, p, want) => { try { await (want ? assertSucceeds(p) : assertFails(p)); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, String(e.message || e).slice(0, 200)); } };

// ---------- 도구 ----------
const kst = (ms = Date.now()) => new Date(ms + 9 * 3600000);
const ymd = d => d.toISOString().slice(0, 10);
const dayPlus = n => ymd(kst(Date.now() + n * 86400000));
const sha = async s => [...new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(x => x.toString(16).padStart(2, '0')).join('');
const memberKey = async (name, last4) => (await sha('member|' + name.trim().normalize('NFC').replace(/\s+/g, ' ').toLowerCase() + '|' + last4)).slice(0, 32);
const onceKeyOf = async (k, name, last4) => k + '_' + (await sha(name.toLowerCase() + '|' + last4)).slice(0, 24);
const anon = uid => env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } }).firestore();

const SCHED = {
  teachers: { sara: { name: '사라센세' } },
  slots: {
    p2: { name: '패턴회화', teacher: 'sara', cap: 10, days: [0, 1, 2, 3, 4, 5, 6], start: '18:30', end: '19:50' },
    p3: { name: '패턴회화2', teacher: 'sara', cap: 10, days: [0, 1, 2, 3, 4, 5, 6], start: '19:50', end: '21:10' },
    t4: { name: '테마회화(上)', teacher: 'sara', cap: 14, days: [0, 1, 2, 3, 4, 5, 6], start: '19:00', end: '21:00' },
    a1: { name: '애니', teacher: 'sara', cap: 5, days: [0, 1, 2, 3, 4, 5, 6], start: '12:00', end: '12:50' },
    soon: { name: '곧시작', teacher: 'sara', cap: 10, days: [0, 1, 2, 3, 4, 5, 6], start: '23:30', end: '23:59' }
  }
};
const costOf = s => { const m = (+SCHED.slots[s].end.slice(0, 2)) * 60 + (+SCHED.slots[s].end.slice(3, 5)) - (+SCHED.slots[s].start.slice(0, 2)) * 60 - (+SCHED.slots[s].start.slice(3, 5)); return m >= 120 ? 2 : 1; };

async function seed(members) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await db.doc('config/schedule').set(SCHED);
    for (const m of members) await db.doc('members/' + m.key).set({ name: m.name, last4: m.last4, start: '2020-01-01', end: '2099-12-31', credits: m.credits, total: m.credits, lastRef: '' });
  });
}
const admin = fn => env.withSecurityRulesDisabled(ctx => fn(ctx.firestore()));

// 학생 화면(student.js)의 예약/취소 묶음 쓰기를 그대로 흉내
async function book(db, uid, mem, date, slot, n) {
  const k = date + '_' + slot, id = k + '_' + n, once = await onceKeyOf(k, mem.name, mem.last4), cost = costOf(slot);
  const b = db.batch();
  b.set(db.doc('seats/' + id), { date, slot, n, uid, at: 1 });
  b.set(db.doc('bookings/' + id), { date, slot, n, teacher: 'sara', name: mem.name, last4: mem.last4, memberId: mem.key, cost, uid, onceKey: once, at: 1 });
  b.set(db.doc(`members/${mem.key}/mine/${id}`), { date, slot, n, onceKey: once, cost, name: mem.name, uid, at: 1 });
  b.set(db.doc('once/' + once), { uid, date, slot });
  b.update(db.doc('members/' + mem.key), { credits: FV.increment(-cost), lastRef: id });
  return b.commit();
}
async function cancel(db, mem, date, slot, n) {
  const k = date + '_' + slot, id = k + '_' + n, once = await onceKeyOf(k, mem.name, mem.last4), cost = costOf(slot);
  const b = db.batch();
  b.delete(db.doc('seats/' + id)); b.delete(db.doc('bookings/' + id)); b.delete(db.doc('once/' + once));
  b.delete(db.doc(`members/${mem.key}/mine/${id}`));
  b.update(db.doc('members/' + mem.key), { credits: FV.increment(cost), lastRef: id });
  return b.commit();
}
const credits = key => admin(async db => (await db.doc('members/' + key).get()).data().credits);

// ---------- 1) 규칙 시험 ----------
const hong = { name: '홍길동', last4: '1234', credits: 6 }; hong.key = await memberKey(hong.name, hong.last4);
const kim = { name: '김철수', last4: '5678', credits: 3 }; kim.key = await memberKey(kim.name, kim.last4);
await seed([hong, kim]);
const D = dayPlus(3);

await t('R1 1회짜리 수업 예약 성공', book(anon('phoneA'), 'phoneA', hong, D, 'p2', 1), true);
ok('R1b 횟수 6→5', (await credits(hong.key)) === 5, await credits(hong.key));
await t('R2 같은 좌석 번호는 다른 사람이 못 잡음', book(anon('x1'), 'x1', kim, D, 'p2', 1), false);
await t('R3 120분 이상 수업(2회) 예약 성공', book(anon('phoneA'), 'phoneA', hong, D, 't4', 1), true);
ok('R3b 횟수 5→3 (2회 차감)', (await credits(hong.key)) === 3, await credits(hong.key));
await t('R4 정원(10) 초과 좌석번호 11 거절', book(anon('x2'), 'x2', kim, D, 'p2', 11), false);
await t('R5 열리지 않은 날짜(60일 뒤) 예약 거절', book(anon('x3'), 'x3', kim, dayPlus(60), 'p2', 2), false);
await t('R6 번호가 틀린 사람 예약 거절', book(anon('x4'), 'x4', { ...kim, last4: '0000' }, D, 'p2', 3), false);
await admin(async db => { await db.doc('members/' + kim.key).update({ credits: 1 }); });
await t('R7 잔여 1회로는 2회짜리 수업 거절', book(anon('x5'), 'x5', kim, D, 't4', 2), false);
await t('R7b 1회짜리는 가능', book(anon('x5'), 'x5', kim, D, 'a1', 1), true);
await t('R8 회차를 마음대로 늘리기 거절', anon('x5').doc('members/' + kim.key).update({ credits: FV.increment(5), lastRef: 'zz' }), false);
await t('R9 회원 목록 읽기 거절', anon('x5').collection('members').get(), false);
await t('R10 남의 예약 문서 읽기 거절', anon('x5').doc(`bookings/${D}_p2_1`).get(), false);
await t('R11 이름+번호 아는 사람은 어느 기기에서든 내 예약 목록을 읽음', anon('phoneB').collection(`members/${hong.key}/mine`).get(), true);

// 24시간 이내 취소 불가
await admin(async db => { await db.doc('members/' + kim.key).update({ credits: 5 }); });
await t('R12 오늘 수업 예약', book(anon('phoneA'), 'phoneA', kim, dayPlus(0), 'soon', 1), true);
await t('R12b 24시간 이내 취소 거절', cancel(anon('phoneA'), kim, dayPlus(0), 'soon', 1), false);

// 다른 기기에서 취소
await t('R13 모르는 사람이 남의 예약 지우기 거절', (async () => { const db = anon('evil'); const b = db.batch(); b.delete(db.doc(`seats/${D}_p2_1`)); b.delete(db.doc(`bookings/${D}_p2_1`)); return b.commit(); })(), false);
await t('R14 다른 기기(phoneB)에서 본인 확인 후 취소 + 환불', cancel(anon('phoneB'), hong, D, 'p2', 1), true);
ok('R14b 환불되어 횟수 3→4', (await credits(hong.key)) === 4, await credits(hong.key));
await t('R15 다른 기기에서 2회짜리 취소 + 2회 환불', cancel(anon('phoneC'), hong, D, 't4', 1), true);
ok('R15b 횟수 4→6', (await credits(hong.key)) === 6, await credits(hong.key));
ok('R15c 좌석/예약/사본이 모두 삭제됨', await admin(async db => (await db.doc(`seats/${D}_t4_1`).get()).exists === false && (await db.doc(`bookings/${D}_t4_1`).get()).exists === false && (await db.doc(`members/${hong.key}/mine/${D}_t4_1`).get()).exists === false));
await t('R16 환불만 따로 받으려는 시도(예약 문서 그대로) 거절', anon('phoneB').doc('members/' + hong.key).update({ credits: FV.increment(1), lastRef: `${D}_a1_1` }), false);

// ---------- 2) 동시 접속 시험 ----------
const USERS = 200, DATES = [dayPlus(2), dayPlus(3), dayPlus(4)], SLOTS = ['p2', 'p3', 'a1', 't4'];
const mems = [];
for (let i = 0; i < USERS; i++) { const m = { name: '수강생' + i, last4: String(1000 + i), credits: 8 }; m.key = await memberKey(m.name, m.last4); mems.push(m); }
await seed(mems);
const classes = []; for (const d of DATES) for (const s of SLOTS) classes.push([d, s]);
const dbs = mems.map((m, i) => anon('dev' + i));
const stats = { tries: 0, conflicts: 0, booked: 0, giveup: 0 };
const mybook = mems.map(() => []);
const rnd = n => Math.floor(Math.random() * n);

async function userBooks(i) {
  const m = mems[i], db = dbs[i];
  for (let want = 0; want < 3; want++) {
    const [d, s] = classes[rnd(classes.length)];
    if (mybook[i].some(b => b.d === d && b.s === s)) continue;
    const cap = SCHED.slots[s].cap, tried = new Set(); let done = false;
    for (let a = 0; a < 8 && tried.size < cap && !done; a++) {
      const free = []; for (let n = 1; n <= cap; n++) if (!tried.has(n)) free.push(n);
      const n = free[rnd(free.length)]; tried.add(n); stats.tries++;
      try { await book(db, 'dev' + i, m, d, s, n); mybook[i].push({ d, s, n }); stats.booked++; done = true; }
      catch (e) { stats.conflicts++; await new Promise(r => setTimeout(r, 50 + rnd(150))); }
    }
    if (!done) stats.giveup++;
  }
}
async function userCancels(i) {
  const m = mems[i], db = dbs[i];
  if (!mybook[i].length) return;
  const b = mybook[i].splice(rnd(mybook[i].length), 1)[0];
  try { await cancel(db, m, b.d, b.s, b.n); stats.cancelled = (stats.cancelled || 0) + 1; } catch (e) { stats.cancelFail = (stats.cancelFail || 0) + 1; mybook[i].push(b); }
}
let t0 = Date.now();
await Promise.all(mems.map((_, i) => userBooks(i)));
console.log(`\n[동시 예약] ${USERS}명, 소요 ${(Date.now() - t0) / 1000}s, 시도 ${stats.tries}, 겹쳐서 실패 ${stats.conflicts}, 성공 ${stats.booked}, 포기 ${stats.giveup}`);
t0 = Date.now();
await Promise.all(mems.map((_, i) => (i % 2 === 0 ? userCancels(i) : userBooks(i))));   // 절반은 취소, 절반은 추가 예약이 동시에
console.log(`[취소+예약 동시] 소요 ${(Date.now() - t0) / 1000}s, 취소 ${stats.cancelled || 0}, 취소 실패 ${stats.cancelFail || 0}`);

await admin(async db => {
  const seats = (await db.collection('seats').get()).docs.map(d => d.id);
  const books = (await db.collection('bookings').get()).docs.map(d => ({ id: d.id, ...d.data() }));
  const perClass = {}; seats.forEach(id => { const k = id.split('_').slice(0, 2).join('_'); perClass[k] = (perClass[k] || 0) + 1; });
  ok('C1 어느 수업도 정원을 넘지 않음', Object.entries(perClass).every(([k, c]) => c <= SCHED.slots[k.split('_')[1]].cap), JSON.stringify(perClass));
  ok('C2 좌석 수 = 예약 수', seats.length === books.length, `${seats.length} vs ${books.length}`);
  let mirrors = 0, bad = 0;
  for (const m of mems) {
    const spent = books.filter(b => b.memberId === m.key).reduce((a, b) => a + b.cost, 0);
    const cur = (await db.doc('members/' + m.key).get()).data().credits;
    mirrors += (await db.collection(`members/${m.key}/mine`).get()).size;
    if (cur !== 8 - spent || cur < 0) bad++;
  }
  ok('C3 모든 수강생의 남은 횟수 = 8 − (예약 합계), 음수 없음', bad === 0, bad + '명 어긋남');
  ok('C4 사본 수 = 예약 수', mirrors === books.length, `${mirrors} vs ${books.length}`);
  ok('C5 같은 사람이 같은 수업을 두 번 예약하지 않음', new Set(books.map(b => b.onceKey)).size === books.length);
  console.log(`   (수업별 예약 수) ${JSON.stringify(perClass)}`);
});

await env.cleanup();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
