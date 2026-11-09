// Firebase 서버 함수: 관리자만 호출할 수 있는 "사진·PDF 읽기"
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { runAi } from './ai-core.js';

initializeApp();
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const ADMIN_EMAIL = 'yeri041025@gmail.com';
const DAILY_LIMIT = 30;   // 하루 최대 읽기 횟수 (실수로 많이 눌러도 비용이 늘지 않게)

export const readDocument = onCall(
  { region: 'asia-northeast3', secrets: [ANTHROPIC_API_KEY], memory: '512MiB', timeoutSeconds: 120, maxInstances: 3 },
  async req => {
    const t = req.auth && req.auth.token;
    if (!t || t.firebase.sign_in_provider !== 'google.com' || t.email_verified !== true) throw new HttpsError('unauthenticated', '관리자 로그인이 필요합니다.');
    const db = getFirestore();
    let isAdmin = t.email === ADMIN_EMAIL;
    if (!isAdmin) { const s = await db.doc('staff/' + t.email).get(); isAdmin = s.exists && s.data().role === 'admin'; }
    if (!isAdmin) throw new HttpsError('permission-denied', '관리자만 사용할 수 있습니다.');

    // 하루 사용 횟수 제한
    const day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    const ref = db.doc('ai_usage/' + day);
    await db.runTransaction(async tx => {
      const cur = (await tx.get(ref)).data();
      if (cur && cur.count >= DAILY_LIMIT) throw new HttpsError('resource-exhausted', '오늘 사용 한도(' + DAILY_LIMIT + '회)를 모두 썼어요.');
      tx.set(ref, { count: FieldValue.increment(1) }, { merge: true });
    });

    try {
      const { kind, mime, data } = req.data || {};
      return await runAi({ kind, mime, data, apiKey: ANTHROPIC_API_KEY.value() });
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      if (e.code === 'invalid-argument') throw new HttpsError('invalid-argument', '파일 형식이나 크기가 맞지 않습니다.');
      if (e.code === 'resource-exhausted') throw new HttpsError('resource-exhausted', 'AI 서비스가 잠시 바쁩니다. 잠시 후 다시 시도해주세요.');
      console.error('readDocument failed', e.message);
      throw new HttpsError('internal', '읽지 못했습니다. 더 선명한 사진으로 다시 시도해주세요.');
    }
  }
);
