// 관리자 화면: 수납장부/신청내역 엑셀로 수강생 업데이트, 시간표 파일로 시간표 업데이트
import { readTableFile } from "./xlsx-lite.js";
import { parseLedger, planMembers, memberWrite, parseScheduleRows, parseScheduleText, planSchedule, applySchedulePlan } from "./import-tools.js";
import { memberKey, dotDate, shiftMonth, kstToday, esc, DOW, daysLabel } from "./schedule.js";

export function initImport(ctx) {
  const { db, fs, getMembers, getSched, getBookings, rerender, callAI } = ctx;
  const { doc, writeBatch, setDoc, increment } = fs;
  const today = kstToday();

  /* ====================== 사진·PDF 읽기 (AI) ====================== */
  const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  async function prepare(file, kind) {
    if (kind === 'pdf') {
      if (file.size > 6 * 1024 * 1024) throw new Error('PDF가 너무 커요 (6MB 이하). 쪽수를 줄이거나 사진으로 올려주세요.');
      return { mime: 'application/pdf', data: b64(new Uint8Array(await file.arrayBuffer())) };
    }
    // 사진은 글자가 읽히는 정도로 줄여서 보냅니다 (속도·비용 절약)
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.88));
    return { mime: 'image/jpeg', data: b64(new Uint8Array(await blob.arrayBuffer())) };
  }
  function aiErrorText(e) {
    const c = String((e && e.code) || '');
    if (/not-found|unavailable/.test(c)) return '사진·PDF 읽기 기능이 아직 설정되지 않았어요. 설정이 끝나면 쓸 수 있어요. (DEPLOY.md의 "사진·PDF 읽기 켜기")';
    if (/resource-exhausted/.test(c)) return (e.message || '오늘 사용 한도를 모두 썼어요.');
    if (/permission-denied|unauthenticated/.test(c)) return '관리자 계정으로 로그인해야 사용할 수 있어요.';
    return (e && e.message && !/^internal$/i.test(e.message) && !/functions\//.test(c) ? e.message : '읽지 못했어요. 더 선명한 사진으로 다시 시도해주세요.');
  }
  async function aiRows(file, kind, what) {
    const prep = await prepare(file, kind === 'pdf' ? 'pdf' : 'image');
    const out = await callAI({ kind: what, mime: prep.mime, data: prep.data });
    return out;
  }

  /* ====================== 수강생: 엑셀로 업데이트 ====================== */
  const mi = { stage: 'idle', fileName: '', items: [], skipped: [], error: '', msg: '', busy: false, kind: '', aiNote: '' };

  const ACTIONS = {
    create: '신규 등록', skip: '건너뜀', adjust: '기간·총횟수 맞춤 (사용한 횟수는 유지)', replace: '새 수강권으로 교체', add: '횟수 추가 (+기간 연장)'
  };
  const optionsFor = it => (it.existing ? ['skip', 'adjust', 'replace', 'add'] : ['create', 'skip']);

  function exSummary(ex) {
    if (!ex) return '<span class="mi-new">새 수강생</span>';
    return '지금: ' + esc(dotDate(ex.start)) + ' – ' + esc(dotDate(ex.end)) + ' · 남은 ' + (ex.credits || 0) + ' / 총 ' + (ex.total || 0) + '회';
  }
  function miRow(it, i) {
    const bad = !!it.issue;
    const opts = optionsFor(it).map(a => '<option value="' + a + '"' + (it.action === a ? ' selected' : '') + '>' + ACTIONS[a] + '</option>').join('');
    return '<li class="mi-row' + (bad ? ' bad' : '') + (it.action === 'skip' ? ' skip' : '') + '">'
      + '<div class="mi-top"><b>' + esc(it.name) + '</b>'
      + (it.last4 ? '<small>' + esc(it.last4) + (it.matchedByName ? ' (이름으로 찾음)' : '') + '</small>' : '<input class="mi-in sm" data-mi="' + i + '" data-f="last4" inputmode="numeric" maxlength="4" placeholder="뒤 4자리">')
      + '<select class="mi-in" data-mi="' + i + '" data-f="action">' + opts + '</select></div>'
      + '<div class="mi-mid"><label>시작<input class="mi-in" type="date" data-mi="' + i + '" data-f="start" value="' + esc(it.start || '') + '"></label>'
      + '<label>종료<input class="mi-in" type="date" data-mi="' + i + '" data-f="end" value="' + esc(it.end || '') + '"></label>'
      + '<label>횟수<input class="mi-in sm" type="number" min="0" max="999" data-mi="' + i + '" data-f="credits" value="' + (it.credits == null ? '' : it.credits) + '"></label></div>'
      + '<div class="mi-low"><small>' + exSummary(it.existing) + '</small>'
      + (it.notes && it.notes.length ? '<small class="mi-note">' + esc(it.notes.join(' + ')) + '</small>' : '')
      + (it.issue ? '<small class="mi-issue">⚠ ' + esc(it.issue) + '</small>' : '') + (it.warn && !it.issue ? '<small class="mi-issue">⚠ ' + esc(it.warn) + '</small>' : '') + '</div></li>';
  }
  function memberImportHtml() {
    let h = '<section class="panel"><h2>수납장부·신청내역 엑셀로 수강생 업데이트</h2>'
      + '<p class="hint">수납장부나 수강신청 내역(.xlsx, .csv)을 올리면 이름·상품·기간·횟수를 읽어서 지금 등록된 수강생과 비교합니다. 바로 저장하지 않고, 아래 미리보기에서 확인한 뒤 <b>반영</b>을 누를 때만 저장돼요.</p>'
      + '<ul class="hint mi-rules"><li>필요한 열: <b>이름(또는 학생)</b>, <b>강의/상품</b> 또는 <b>시작·종료·횟수</b>. 전화번호 열이 있으면 뒤 4자리만 가져옵니다. (전체 번호는 저장하지 않아요)</li>'
      + '<li>횟수가 없으면 상품 이름으로 계산해요: 요일&amp;시간자유 월 8회, 월수·화목 월 8회, 금·토 등 월 4회, 절반권 4회 (×개월 수). 틀린 건 미리보기에서 고치면 됩니다.</li>'
      + '<li>번호 열이 없으면 이미 등록된 같은 이름으로 찾고, 새 수강생은 번호를 직접 넣어야 해요. 취소·환불 상태인 줄은 빼고 읽어요.</li>'
      + '<li>사진·PDF도 올릴 수 있어요. AI가 읽고 같은 미리보기로 보여줘요. 전화번호는 뒤 4자리만 쓰도록 시키지만, 사진 자체는 Anthropic의 AI 서비스로 전송되니 불필요한 개인정보는 가리고 올려주세요. (하루 30회까지)</li></ul>'
      + '<label class="filebtn"><input data-mi-file type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt,.xls,.pdf,image/*"><span class="act">파일 고르기</span></label>';
    if (mi.busy) h += '<p class="hint">' + (mi.busy === 'ai' ? 'AI가 사진을 읽는 중이에요… (10~30초)' : '읽는 중…') + '</p>';
    if (mi.aiNote && mi.stage === 'preview') h += '<p class="msg warnbox" role="status">' + esc(mi.aiNote) + '</p>';
    if (mi.fileName) h += '<p class="hint">선택한 파일: <b>' + esc(mi.fileName) + '</b></p>';
    if (mi.error) h += '<p class="msg err" role="status">' + esc(mi.error) + '</p>';
    if (mi.stage === 'preview' && mi.items.length) {
      const c = k => mi.items.filter(x => x.action === k).length;
      const todo = mi.items.filter(x => x.action !== 'skip');
      const blocked = todo.filter(x => x.issue || !x.start || !x.end || x.credits == null || !x.last4).length;
      h += '<div class="mi-sum"><span class="pill ok">신규 ' + c('create') + '</span><span class="pill warn">변경 ' + (c('adjust') + c('replace') + c('add')) + '</span><span class="pill off">건너뜀 ' + c('skip') + '</span>'
        + (blocked ? '<span class="pill full">확인 필요 ' + blocked + '</span>' : '') + '</div>'
        + '<ul class="mi-list">' + mi.items.map(miRow).join('') + '</ul>';
      if (mi.skipped.length) h += '<p class="hint">제외한 줄(취소·환불 등): ' + esc(mi.skipped.join(', ')) + '</p>';
      h += '<div class="btnrow"><button class="primary" type="button" data-mi-apply ' + (blocked || !todo.length ? 'disabled' : '') + '>' + todo.length + '명 반영</button><button class="act" type="button" data-mi-cancel>취소</button></div>'
        + (blocked ? '<p class="hint">⚠ 표시된 줄(번호·기간·횟수 비어 있음)을 채우거나 "건너뜀"으로 바꾸면 반영할 수 있어요.</p>' : '');
    }
    if (mi.msg) h += '<p class="msg good" role="status">' + esc(mi.msg) + '</p>';
    return h + '</section>';
  }
  function noFileKind(kind) {
    if (kind === 'image' || kind === 'pdf') return '사진·PDF를 읽지 못했어요.';
    if (kind === 'xls') return '예전 형식(.xls)은 읽지 못해요. 엑셀에서 "다른 이름으로 저장 → .xlsx" 또는 CSV로 저장해서 올려주세요.';
    return '';
  }
  async function readMemberFile(file) {
    Object.assign(mi, { stage: 'idle', fileName: file.name, items: [], skipped: [], error: '', msg: '', busy: true }); rerender();
    try {
      let res = await readTableFile(file.name, await file.arrayBuffer()), aiNote = '';
      if (res.kind === 'image' || res.kind === 'pdf') {
        mi.busy = 'ai'; rerender();
        const out = await aiRows(file, res.kind, 'ledger');
        res = { kind: 'table', sheets: [{ name: 'AI', rows: out.rows }] };
        aiNote = 'AI가 사진에서 읽은 결과예요. 이름·기간·횟수가 맞는지 꼭 확인하세요.' + (out.notes ? ' (AI 메모: ' + out.notes + ')' : '');
      }
      mi.aiNote = aiNote;
      if (res.kind !== 'table') { mi.error = noFileKind(res.kind); mi.busy = false; return rerender(); }
      let best = null;
      for (const sh of res.sheets) { const r = parseLedger(sh.rows); if (!r.error && (!best || r.entries.length > best.entries.length)) best = r; }
      if (!best) { mi.error = parseLedger(res.sheets[0] ? res.sheets[0].rows : []).error || '표를 읽지 못했어요.'; mi.busy = false; return rerender(); }
      if (!best.entries.length) { mi.error = '읽을 수 있는 수강생 줄이 없어요.'; mi.busy = false; return rerender(); }
      mi.items = await planMembers(best.entries, getMembers()); mi.skipped = best.skipped; mi.stage = 'preview';
    } catch (e) { mi.error = mi.busy === 'ai' ? aiErrorText(e) : '파일을 읽지 못했어요. 엑셀 파일이 맞는지 확인해주세요.'; }
    mi.busy = false; rerender();
  }
  async function miChange(i, f, val) {
    const it = mi.items[i]; if (!it) return;
    if (f === 'credits') it.credits = val === '' ? null : Math.max(0, parseInt(val, 10) || 0);
    else if (f === 'last4') {
      if (!/^\d{4}$/.test(val)) return;
      it.last4 = val; it.id = await memberKey(it.name, val); it.existing = getMembers().find(m => m.id === it.id) || null;
      it.action = it.existing ? 'adjust' : 'create'; it.issue = '';
    } else if (f === 'action') it.action = val;
    else it[f] = val;
    if (f !== 'last4' && f !== 'action') { if (it.start && it.end && it.credits != null && it.last4) it.issue = ''; }
    if (f === 'start' || f === 'end') { if (it.start && it.end && it.start > it.end) it.issue = '종료일이 시작일보다 빨라요'; }
    rerender();
  }
  async function miApply() {
    const todo = mi.items.filter(x => x.action !== 'skip');
    if (!todo.length) return;
    mi.busy = true; mi.error = ''; rerender();
    try {
      let done = 0;
      for (let i = 0; i < todo.length; i += 150) {
        const batch = writeBatch(db);
        todo.slice(i, i + 150).forEach(it => {
          const w = memberWrite(it); if (!w) return;
          const ref = doc(db, 'members', it.id);
          if (w.op === 'set') batch.set(ref, w.data);
          else {
            const d = Object.assign({}, w.data);
            if (w.inc) Object.keys(w.inc).forEach(k => { d[k] = increment(w.inc[k]); });
            batch.update(ref, d);
          }
          done++;
        });
        await batch.commit();
      }
      mi.msg = done + '명을 반영했어요. (신규 ' + todo.filter(x => x.action === 'create').length + ' · 변경 ' + todo.filter(x => x.action !== 'create').length + ')';
      mi.items = []; mi.stage = 'idle'; mi.fileName = '';
    } catch (e) { mi.error = '일부를 저장하지 못했어요. 잠시 후 같은 파일을 다시 올리면 이미 반영된 사람은 "건너뜀"으로 나옵니다.'; }
    mi.busy = false; rerender();
  }

  /* ====================== 시간표: 파일로 업데이트 ====================== */
  const si = { stage: 'idle', aiNote: '', fileName: '', parsed: null, effective: '', teacherMap: {}, keepEnd: {}, error: '', msg: '', busy: false, text: '', lastBackup: null, asking: false };
  const defaultEffective = () => shiftMonth(today.slice(0, 7), 1) + '-01';
  si.effective = defaultEffective();

  function compute() {
    if (!si.parsed) return null;
    const sched = getSched(); if (!sched) return null;
    const plan = planSchedule(sched, si.parsed.slots, si.effective, si.teacherMap);
    return plan;
  }
  function slotLine(s, sched) {
    const t = s.teacher && sched.teachers[s.teacher] ? sched.teachers[s.teacher].name : (s.teacherText || '담당 미정');
    return '<b>' + esc(s.name) + '</b> <small>' + esc(t) + ' · ' + esc(daysLabel(s.days)) + ' ' + esc(s.start) + '–' + esc(s.end) + (s.cap ? ' · 정원 ' + s.cap + '명' : '') + '</small>';
  }
  function schedImportHtml() {
    const sched = getSched();
    let h = '<section class="panel"><h2>새 시간표 파일로 업데이트</h2>'
      + '<p class="hint">매월 바뀌는 시간표를 파일로 올리면 읽어서 현재 시간표와 비교해요. <b>기존 수업은 지우지 않고</b>, 바뀌는 날 전날까지로 "종료" 처리하고 새 수업을 그 날부터 "시작"으로 넣습니다. 그래서 지난 예약과 이번 달 수업은 그대로 남아요. 바꾸기 직전 시간표는 자동으로 백업돼서 한 번에 되돌릴 수도 있어요.</p>'
      + '<ul class="hint mi-rules"><li>엑셀·CSV: 첫 줄에 <b>수업명, 요일, 시간(10:20-11:40), 센세</b> 제목이 있는 목록, 또는 월~일이 가로로 놓인 시간표 모양이면 읽어요.</li>'
      + '<li>사진·PDF: AI가 읽어서 같은 미리보기로 보여줘요. (사진은 Anthropic의 AI 서비스로 전송됩니다. 하루 30회까지)</li></ul>'
      + '<label class="filebtn"><input data-si-file type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt,.xls,.pdf,image/*"><span class="act">시간표 파일 고르기</span></label>'
      + '<label class="si-text">또는 글로 붙여넣기 <small>(한 줄에 한 수업: 수업명 | 요일 | 시작-끝 | 센세 | 정원(선택))</small>'
      + '<textarea id="si-text" rows="4" placeholder="일본어 패턴회화 | 화목 | 14:00-15:20 | 사라&#10;센세에몽의 회화포켓 | 금 | 18:40-20:50 | 예리">' + esc(si.text) + '</textarea></label>'
      + '<div class="btnrow"><button class="act" type="button" data-si-readtext>붙여넣은 글 읽기</button></div>';
    if (si.busy) h += '<p class="hint">' + (si.busy === 'ai' ? 'AI가 사진을 읽는 중이에요… (10~30초)' : '읽는 중…') + '</p>';
    if (si.aiNote && si.stage === 'preview') h += '<p class="msg warnbox" role="status">' + esc(si.aiNote) + '</p>';
    if (si.fileName) h += '<p class="hint">선택한 파일: <b>' + esc(si.fileName) + '</b></p>';
    if (si.error) h += '<p class="msg err" role="status">' + esc(si.error) + '</p>';
    if (si.stage === 'preview' && si.parsed && sched) {
      const plan = compute();
      const parsedErrs = si.parsed.errs || [];
      h += '<div class="si-eff"><label>새 시간표 적용 시작일<input type="date" data-si-eff value="' + esc(si.effective) + '"></label>'
        + '<small>이 날부터 새 수업이 보이고, 바뀐 기존 수업은 전날까지 유지돼요. 보통 다음 달 1일입니다.' + (si.effective <= today ? ' <b class="mi-issue">⚠ 오늘 이전 날짜라 이미 지난 수업·예약에 영향이 있을 수 있어요.</b>' : '') + '</small></div>';
      if (plan.unresolved.length) {
        h += '<div class="si-teachers"><b>센세 이름 확인</b><small>파일의 이름이 등록된 센세와 달라요. 누구인지 골라주세요. (한 번 고르면 다음부터는 자동으로 알아봐요)</small>'
          + plan.unresolved.filter(Boolean).map(t => '<label>' + esc(t) + ' →<select data-si-teacher="' + esc(t) + '"><option value="__new__">새 센세로 추가</option>'
            + Object.keys(sched.teachers || {}).map(id => '<option value="' + esc(id) + '"' + (si.teacherMap[t] === id ? ' selected' : '') + '>' + esc(sched.teachers[id].name) + '</option>').join('') + '</select></label>').join('')
          + (plan.unresolved.indexOf('') >= 0 ? '<small class="mi-issue">⚠ 센세 이름이 없는 수업이 있어요. 파일에 센세 열을 넣어주세요. (이 수업들은 반영되지 않습니다)</small>' : '') + '</div>';
      }
      const bk = getBookings();
      const endRows = plan.end.map(s => {
        const after = bk.filter(b => b.slot === s.id && b.date >= si.effective).length;
        const on = si.keepEnd[s.id] !== false;
        return '<li class="' + (on ? '' : 'skip') + '"><label><input type="checkbox" data-si-end="' + esc(s.id) + '"' + (on ? ' checked' : '') + '> ' + slotLine(s, sched) + '</label>'
          + (after ? '<small class="mi-issue">이미 예약 ' + after + '건 있음 (그대로 남지만 화면에서 사라져요)</small>' : '') + '</li>';
      }).join('');
      h += '<div class="si-plan"><div class="si-col"><h3><span class="pill ok">신규 ' + plan.add.length + '</span> 새로 시작</h3><ul>' + (plan.add.map(s => '<li>' + slotLine(s, sched) + '</li>').join('') || '<li class="empty">없음</li>') + '</ul></div>'
        + '<div class="si-col"><h3><span class="pill warn">종료 ' + plan.end.length + '</span> 이 날 전까지만 운영 <small>(체크 해제하면 계속 유지)</small></h3><ul>' + (endRows || '<li class="empty">없음</li>') + '</ul></div>'
        + '<div class="si-col"><h3><span class="pill off">그대로 ' + plan.keep.length + '</span> 변경 없음</h3><ul>' + (plan.keep.map(s => '<li>' + slotLine(s, sched) + '</li>').join('') || '<li class="empty">없음</li>') + '</ul></div></div>';
      if (parsedErrs.length) h += '<div class="si-errs"><b>읽지 못한 줄 ' + parsedErrs.length + '개</b><ul>' + parsedErrs.slice(0, 8).map(e => '<li>' + esc(e) + '</li>').join('') + '</ul></div>';
      const nothing = !plan.add.length && !plan.end.some(s => si.keepEnd[s.id] !== false);
      h += '<div class="btnrow"><button class="primary' + '" type="button" data-si-apply ' + (nothing ? 'disabled' : '') + '>' + (si.asking ? '정말 반영합니다. 한 번 더 누르세요' : '시간표 반영') + '</button><button class="act" type="button" data-si-cancel>취소</button></div>';
    }
    if (si.msg) h += '<p class="msg good" role="status">' + esc(si.msg) + '</p>';
    if (si.lastBackup) h += '<div class="btnrow"><button class="act" type="button" data-si-undo>방금 바꾼 시간표 되돌리기</button></div>';
    return h + '</section>';
  }
  function setParsed(res, name) {
    si.fileName = name || ''; si.error = ''; si.msg = ''; si.asking = false;
    if (!res.slots.length) { si.error = (res.errs && res.errs[0]) || '수업을 찾지 못했어요.'; si.stage = 'idle'; si.parsed = null; return; }
    si.parsed = res; si.stage = 'preview'; si.teacherMap = {}; si.keepEnd = {};
  }
  async function readSchedFile(file) {
    si.busy = true; si.error = ''; si.msg = ''; si.fileName = file.name; rerender();
    try {
      let res = await readTableFile(file.name, await file.arrayBuffer());
      si.aiNote = '';
      if (res.kind === 'image' || res.kind === 'pdf') {
        si.busy = 'ai'; rerender();
        const out = await aiRows(file, res.kind, 'schedule');
        res = { kind: 'table', sheets: [{ name: 'AI', rows: out.rows }] };
        si.aiNote = 'AI가 사진에서 읽은 결과예요. 수업 시간·요일·센세가 맞는지 꼭 확인하세요.' + (out.notes ? ' (AI 메모: ' + out.notes + ')' : '');
      }
      if (res.kind !== 'table') { si.error = noFileKind(res.kind) + ' 시간표는 아래 "글로 붙여넣기"를 이용해주세요.'; si.stage = 'idle'; si.parsed = null; }
      else {
        const sched = getSched();
        let best = null;
        for (const sh of res.sheets) { const r = parseScheduleRows(sh.rows, (sched && sched.teachers) || {}); if (r.slots.length && (!best || r.slots.length > best.slots.length)) best = r; }
        setParsed(best || { slots: [], errs: [parseScheduleRows([], {}).errs[0]] }, file.name);
      }
    } catch (e) { si.error = si.busy === 'ai' ? aiErrorText(e) : '파일을 읽지 못했어요. 엑셀 파일이 맞는지 확인해주세요.'; }
    si.busy = false; rerender();
  }
  async function schedApply() {
    const sched = getSched(), plan = compute(); if (!sched || !plan) return;
    if (!si.asking) { si.asking = true; return rerender(); }
    si.asking = false; si.busy = true; si.error = ''; rerender();
    try {
      const endIds = plan.end.filter(s => si.keepEnd[s.id] !== false).map(s => s.id);
      const next = applySchedulePlan(sched, plan, si.effective, endIds, si.teacherMap);
      const backupId = 'backup_' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
      await setDoc(doc(db, 'config', backupId), JSON.parse(JSON.stringify(sched)));
      await setDoc(doc(db, 'config', 'schedule'), next);
      si.lastBackup = backupId;
      si.msg = '시간표를 반영했어요. 새 수업 ' + plan.add.length + '개 시작, 기존 수업 ' + endIds.length + '개 종료 (' + dotDate(si.effective) + ' 기준). 지난 시간표는 지우지 않고 남겨뒀어요.';
      si.stage = 'idle'; si.parsed = null; si.fileName = ''; si.text = '';
    } catch (e) { si.error = '반영하지 못했어요. 잠시 후 다시 시도해주세요. (바뀐 것은 없습니다)'; }
    si.busy = false; rerender();
  }
  async function schedUndo() {
    if (!si.lastBackup) return;
    try {
      const { getDoc } = fs;
      const snap = await getDoc(doc(db, 'config', si.lastBackup));
      if (!snap.exists()) { si.error = '백업을 찾지 못했어요.'; return rerender(); }
      await setDoc(doc(db, 'config', 'schedule'), snap.data());
      si.msg = '방금 바꾼 시간표를 되돌렸어요.'; si.lastBackup = null;
    } catch (e) { si.error = '되돌리지 못했어요.'; }
    rerender();
  }

  /* ====================== 이벤트 ====================== */
  document.addEventListener('change', e => {
    const t = e.target;
    if (t.matches && t.matches('[data-mi-file]')) { const f = t.files && t.files[0]; if (f) readMemberFile(f); t.value = ''; return; }
    if (t.matches && t.matches('[data-mi]')) { miChange(+t.dataset.mi, t.dataset.f, t.value); return; }
    if (t.matches && t.matches('[data-si-file]')) { const f = t.files && t.files[0]; if (f) readSchedFile(f); t.value = ''; return; }
    if (t.matches && t.matches('[data-si-eff]')) { if (t.value) { si.effective = t.value; si.asking = false; rerender(); } return; }
    if (t.matches && t.matches('[data-si-teacher]')) { si.teacherMap[t.dataset.siTeacher] = t.value; si.asking = false; rerender(); return; }
    if (t.matches && t.matches('[data-si-end]')) { si.keepEnd[t.dataset.siEnd] = t.checked; si.asking = false; rerender(); return; }
  });
  document.addEventListener('input', e => { if (e.target.id === 'si-text') si.text = e.target.value; });
  document.addEventListener('click', e => {
    const t = e.target;
    if (t.closest('[data-mi-apply]')) { miApply(); return; }
    if (t.closest('[data-mi-cancel]')) { Object.assign(mi, { stage: 'idle', items: [], fileName: '', error: '', msg: '' }); rerender(); return; }
    if (t.closest('[data-si-readtext]')) {
      const ta = document.getElementById('si-text'); si.text = ta ? ta.value : si.text;
      if (!si.text.trim()) { si.error = '붙여넣은 글이 없어요.'; return rerender(); }
      setParsed(parseScheduleText(si.text), '(붙여넣은 글)'); rerender(); return;
    }
    if (t.closest('[data-si-apply]')) { schedApply(); return; }
    if (t.closest('[data-si-cancel]')) { Object.assign(si, { stage: 'idle', parsed: null, fileName: '', error: '', msg: '', asking: false }); rerender(); return; }
    if (t.closest('[data-si-undo]')) { schedUndo(); return; }
  });

  return { memberImportHtml, schedImportHtml };
}
