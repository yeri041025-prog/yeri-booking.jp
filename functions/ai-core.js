// 사진·PDF 속 시간표/수납장부를 Claude 로 읽어 표(행 배열)로 돌려주는 핵심 로직. (Firebase 와 무관해서 단독 시험 가능)
export const MODEL = 'claude-sonnet-5-5';
export const MAX_DATA_CHARS = 9_000_000;   // base64 글자 수 (원본 약 6.5MB)

const SCHEDULE_TOOL = {
  name: 'submit_schedule',
  description: '사진/PDF에서 읽은 수업 시간표를 제출합니다.',
  input_schema: {
    type: 'object',
    properties: {
      slots: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '수업 이름 (보이는 그대로)' },
            days: { type: 'string', description: '요일을 한글 한 글자씩 이어서. 예: 월수, 화목, 금, 토' },
            start: { type: 'string', description: '시작 시각 24시간 HH:MM' },
            end: { type: 'string', description: '끝나는 시각 24시간 HH:MM' },
            teacher: { type: 'string', description: '담당 센세 이름. 안 보이면 빈 문자열' },
            capacity: { type: 'integer', description: '정원. 안 보이면 0' }
          },
          required: ['name', 'days', 'start', 'end', 'teacher']
        }
      },
      notes: { type: 'string', description: '읽기 어려웠던 부분이나 확인이 필요한 점 (없으면 빈 문자열)' }
    },
    required: ['slots']
  }
};

const LEDGER_TOOL = {
  name: 'submit_ledger',
  description: '사진/PDF에서 읽은 수강 신청·수납 내역을 제출합니다.',
  input_schema: {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            last4: { type: 'string', description: '전화번호의 마지막 4자리 숫자만. 없으면 빈 문자열. 전체 번호는 절대 적지 않음' },
            product: { type: 'string', description: '강의/상품 이름 (보이는 그대로)' },
            start: { type: 'string', description: '수강 시작일 YYYY-MM-DD. 안 보이면 빈 문자열' },
            end: { type: 'string', description: '수강 종료일 YYYY-MM-DD. 안 보이면 빈 문자열' },
            credits: { type: 'integer', description: '횟수. 안 보이면 -1' },
            status: { type: 'string', description: '상태(확정/취소/환불 등). 안 보이면 빈 문자열' }
          },
          required: ['name', 'product']
        }
      },
      notes: { type: 'string' }
    },
    required: ['rows']
  }
};

const PROMPTS = {
  schedule: '이 이미지/문서는 학원 수업 시간표입니다. 보이는 모든 수업을 submit_schedule 로 제출하세요. 같은 수업이 여러 요일에 있으면 요일을 합쳐서 한 줄로 적습니다. 보이지 않거나 확실하지 않은 값은 지어내지 말고 비워두거나 notes 에 적으세요. 시간은 24시간제(오후 7시 → 19:00)로 바꿉니다.',
  ledger: '이 이미지/문서는 학원 수강 신청 또는 수납 내역 표입니다. 각 줄을 submit_ledger 로 제출하세요. 전화번호가 있어도 마지막 4자리만 적고 나머지는 절대 적지 않습니다. 보이지 않거나 확실하지 않은 값은 지어내지 말고 비워두세요. 취소·환불로 보이는 줄도 status 에 그대로 적어 제출합니다.'
};

export function buildRequest(kind, mime, data, model = MODEL) {
  const isPdf = mime === 'application/pdf';
  const media = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : { type: 'image', source: { type: 'base64', media_type: mime, data } };
  const tool = kind === 'schedule' ? SCHEDULE_TOOL : LEDGER_TOOL;
  return {
    model, max_tokens: 8000,
    tools: [tool], tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: [media, { type: 'text', text: PROMPTS[kind] }] }]
  };
}

const s = v => (v == null ? '' : String(v).trim());

export function toRows(kind, input) {
  if (kind === 'schedule') {
    const rows = [['수업명', '요일', '시간', '센세', '정원']];
    (input.slots || []).forEach(x => rows.push([s(x.name), s(x.days), s(x.start) + '-' + s(x.end), s(x.teacher), x.capacity > 0 ? String(x.capacity) : '']));
    return rows;
  }
  const rows = [['이름', '전화번호 뒤 4자리', '강의', '시작', '종료', '횟수', '상태']];
  (input.rows || []).forEach(x => rows.push([s(x.name), s(x.last4).replace(/\D/g, '').slice(-4), s(x.product), s(x.start), s(x.end), x.credits >= 0 ? String(x.credits) : '', s(x.status)]));
  return rows;
}

export async function runAi({ kind, mime, data, apiKey, fetchImpl = fetch, model = MODEL }) {
  if (kind !== 'schedule' && kind !== 'ledger') throw Object.assign(new Error('bad kind'), { code: 'invalid-argument' });
  if (!/^(image\/(png|jpeg|webp|gif)|application\/pdf)$/.test(mime || '')) throw Object.assign(new Error('bad mime'), { code: 'invalid-argument' });
  if (typeof data !== 'string' || !data.length || data.length > MAX_DATA_CHARS) throw Object.assign(new Error('bad size'), { code: 'invalid-argument' });
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(buildRequest(kind, mime, data, model))
  });
  if (!res.ok) { const e = new Error('anthropic ' + res.status); e.code = res.status === 429 ? 'resource-exhausted' : 'internal'; e.status = res.status; throw e; }
  const body = await res.json();
  const block = (body.content || []).find(b => b.type === 'tool_use');
  if (!block || !block.input) throw Object.assign(new Error('no result'), { code: 'internal' });
  return { rows: toRows(kind, block.input), notes: s(block.input.notes), count: kind === 'schedule' ? (block.input.slots || []).length : (block.input.rows || []).length };
}
