/**
 * api-mango.ts - v3 명세서 신규 API
 *  - 출석 자동 감지 / 발화시간(VAD) 기록
 *  - 비상 카카오 ID 관리 / 비상 이벤트 로깅
 *  - 보상(스티커/쿠폰) 발급 with 일일 상한
 *  - 관리 대시보드 KPI
 */

export interface MangoEnv {
  DB: D1Database;
  SESSION_STATE: KVNamespace;
}

const json = (data: any, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });

const today = (ts: number = Date.now()) => {
  const d = new Date(ts);
  // KST 기준 날짜
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10);
};

/**
 * 빈/잘못된 JSON body 를 안전하게 파싱.
 * 🩺 셀프 진단 페이지가 빈 POST 로 self-ping 할 때 500 대신 400 이 나오도록 하는 공통 방어막.
 *   - body 없음 / 비어있음 / JSON 아님 → null 반환 (호출자가 400 응답)
 *   - 정상 JSON → 파싱된 객체
 */
async function parseJsonBody(request: Request): Promise<any | null> {
  try {
    const text = await request.text();
    if (!text || !text.trim()) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 필수 필드 누락 시 400 응답 생성 — 에러 메시지에 필드명 포함 (디버깅 편의) */
const invalidBody = (required: string[]): Response =>
  json({ ok: false, error: 'invalid_body', required }, 400);

/**
 * 📥 CSV 직렬화 (Phase 6)
 *   - 행에 따옴표/콤마/개행 들어가면 RFC 4180 방식으로 escape
 *   - 맨 앞에 UTF-8 BOM 붙여 Excel 한글 깨짐 방지
 *   - columns 의 순서가 그대로 헤더·셀 매핑에 사용됨
 */
function toCSV(rows: any[], columns: { key: string; label?: string }[]): string {
  const escape = (v: any): string => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = columns.map(c => escape(c.label || c.key)).join(',');
  const body = rows.map(r => columns.map(c => escape(r[c.key])).join(',')).join('\n');
  return '﻿' + header + '\n' + body + '\n';
}

// ========================================================================
// 💼 Payroll (Phase 8) — Mangoi 강사 급여·평가 시스템
//   - 모델: salary-heatmap.pages.dev 와 동일
//   - 월급 = 총 수업수(20분 단위) × 2 × 10분당 단가(PHP)
//   - 평가 = 5개 카테고리 가중 평균 → 4등급 자동 분류
//   - 근무 형태: 'office' | 'home' (rank 폐기, 호환성 위해 컬럼만 유지)
//   - 환율: 1 PHP = 24.34 KRW (트리맵·요약용)
// ========================================================================

/** 환율 — KRW 표시용 (트리맵 등). 정기적 갱신 필요 시 wrangler vars 로 빼낼 것. */
const PAYROLL_PHP_TO_KRW = 24.34;

/** 평가 카테고리 가중치 (합계 1.0). */
const EVAL_WEIGHTS = {
  instruction:  0.25,  // 수업 우수성 (Instructional Excellence)
  retention:    0.30,  // 학생 재등록 유지율
  punctuality:  0.20,  // 성실성 / 시간엄수
  admin:        0.15,  // 행정 / 업무 성실도
  contribution: 0.10,  // 조직 기여도
};

/** 등급 임계값 + 라벨. */
function classifyEvalGrade(weighted: number): string {
  if (weighted == null || isNaN(weighted)) return '미평가';
  if (weighted >= 4.75) return '최우수';
  if (weighted >= 4.50) return '매우 우수';
  if (weighted >= 3.50) return '우수';
  return '개선 요망';
}

const VALID_TEACHER_STATUS = ['office', 'home'] as const;

let _payrollSchemaReady = false;
async function ensurePayrollSchema(env: { DB: D1Database }): Promise<void> {
  if (_payrollSchemaReady) return;
  // teachers — 기존 호환 + 신규 컬럼
  await env.DB.exec([
    `CREATE TABLE IF NOT EXISTS teachers (`,
    `  id INTEGER PRIMARY KEY AUTOINCREMENT,`,
    `  user_id TEXT,`,
    `  name TEXT NOT NULL,`,
    `  center_id INTEGER,`,
    `  rank TEXT,`,                                    // deprecated, NOT NULL 해제 (있으면 NULL 허용)
    `  hourly_rate_php INTEGER,`,                      // deprecated, 새 모델은 rate_per_10min_php 사용
    `  status TEXT,`,                                   // 'office' | 'home'
    `  years INTEGER,`,                                 // 근속 연수
    `  rate_per_10min_php REAL,`,                       // 10분당 단가 (강사별)
    `  active INTEGER DEFAULT 1,`,
    `  created_at INTEGER NOT NULL,`,
    `  updated_at INTEGER NOT NULL`,
    `);`
  ].join(' '));
  await env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_teachers_active ON teachers(active);`);
  // 기존 DB 에 컬럼 누락 시 ALTER 로 추가 (이미 있으면 SQLite 가 throw → 흡수)
  for (const ddl of [
    `ALTER TABLE teachers ADD COLUMN status TEXT;`,
    `ALTER TABLE teachers ADD COLUMN years INTEGER;`,
    `ALTER TABLE teachers ADD COLUMN rate_per_10min_php REAL;`,
  ]) {
    try { await env.DB.exec(ddl); } catch { /* duplicate column — 정상 */ }
  }

  // 월별 수업 수 (20분 단위)
  await env.DB.exec([
    `CREATE TABLE IF NOT EXISTS teacher_monthly_classes (`,
    `  id INTEGER PRIMARY KEY AUTOINCREMENT,`,
    `  teacher_id INTEGER NOT NULL,`,
    `  year INTEGER NOT NULL,`,
    `  month INTEGER NOT NULL,`,
    `  class_count INTEGER NOT NULL DEFAULT 0,`,
    `  notes TEXT,`,
    `  updated_at INTEGER NOT NULL,`,
    `  UNIQUE(teacher_id, year, month)`,
    `);`
  ].join(' '));
  await env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_tmc_year_month ON teacher_monthly_classes(year, month);`);

  // 월별 평가 (5개 카테고리 점수 + 가중 합계 + 등급)
  await env.DB.exec([
    `CREATE TABLE IF NOT EXISTS teacher_evaluations (`,
    `  id INTEGER PRIMARY KEY AUTOINCREMENT,`,
    `  teacher_id INTEGER NOT NULL,`,
    `  year INTEGER NOT NULL,`,
    `  month INTEGER NOT NULL,`,
    `  score_instruction REAL,`,
    `  score_retention REAL,`,
    `  score_punctuality REAL,`,
    `  score_admin REAL,`,
    `  score_contribution REAL,`,
    `  weighted_total REAL,`,
    `  grade TEXT,`,
    `  strengths TEXT,`,
    `  improvements TEXT,`,
    `  evaluator TEXT,`,
    `  evaluated_at INTEGER,`,
    `  UNIQUE(teacher_id, year, month)`,
    `);`
  ].join(' '));
  await env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_te_year_month ON teacher_evaluations(year, month);`);

  // payslips — 마감용 (새 모델 컬럼)
  await env.DB.exec([
    `CREATE TABLE IF NOT EXISTS payslips (`,
    `  id INTEGER PRIMARY KEY AUTOINCREMENT,`,
    `  teacher_id INTEGER NOT NULL,`,
    `  year INTEGER NOT NULL,`,
    `  month INTEGER NOT NULL,`,
    `  status TEXT,`,
    `  class_count INTEGER,`,
    `  rate_per_10min_php REAL,`,
    `  monthly_salary_php REAL,`,
    `  weighted_total REAL,`,
    `  grade TEXT,`,
    `  finalized_at INTEGER NOT NULL,`,
    `  finalized_by TEXT,`,
    `  UNIQUE(teacher_id, year, month)`,
    `);`
  ].join(' '));
  // 기존 payslips 테이블에 새 컬럼 추가 (재배포 호환)
  for (const ddl of [
    `ALTER TABLE payslips ADD COLUMN status TEXT;`,
    `ALTER TABLE payslips ADD COLUMN class_count INTEGER;`,
    `ALTER TABLE payslips ADD COLUMN rate_per_10min_php REAL;`,
    `ALTER TABLE payslips ADD COLUMN monthly_salary_php REAL;`,
    `ALTER TABLE payslips ADD COLUMN weighted_total REAL;`,
    `ALTER TABLE payslips ADD COLUMN grade TEXT;`,
  ]) {
    try { await env.DB.exec(ddl); } catch { /* duplicate column — 정상 */ }
  }

  _payrollSchemaReady = true;
}

/** 평가 점수 5개 → 가중 합계 (없으면 null). */
function calcWeightedTotal(e: {
  score_instruction?: number | null,
  score_retention?: number | null,
  score_punctuality?: number | null,
  score_admin?: number | null,
  score_contribution?: number | null,
} | null): number | null {
  if (!e) return null;
  const i = e.score_instruction, r = e.score_retention, p = e.score_punctuality,
        a = e.score_admin, c = e.score_contribution;
  // 5개 모두 있어야 합산
  if ([i, r, p, a, c].some(v => v == null || isNaN(Number(v)))) return null;
  const total = Number(i) * EVAL_WEIGHTS.instruction
              + Number(r) * EVAL_WEIGHTS.retention
              + Number(p) * EVAL_WEIGHTS.punctuality
              + Number(a) * EVAL_WEIGHTS.admin
              + Number(c) * EVAL_WEIGHTS.contribution;
  return Math.round(total * 100) / 100;
}

/**
 * 한 강사의 월 급여·평가 통합 계산.
 *   월급 = class_count × 2 × rate_per_10min_php
 *   평가 = teacher_evaluations 의 5개 점수 → 가중 합계 → 등급
 */
async function calcPayrollOne(env: { DB: D1Database }, teacherId: number, year: number, month: number): Promise<any> {
  const t: any = await env.DB.prepare(
    `SELECT id, name, status, years, rate_per_10min_php, hourly_rate_php, rank, center_id, active
     FROM teachers WHERE id = ?`
  ).bind(teacherId).first();
  if (!t) return { ok: false, error: 'teacher_not_found', teacher_id: teacherId };

  const cl: any = await env.DB.prepare(
    `SELECT class_count, notes FROM teacher_monthly_classes
     WHERE teacher_id = ? AND year = ? AND month = ?`
  ).bind(teacherId, year, month).first();
  const classCount = cl ? Number(cl.class_count) : 0;

  const ev: any = await env.DB.prepare(
    `SELECT score_instruction, score_retention, score_punctuality, score_admin, score_contribution,
            weighted_total, grade, strengths, improvements, evaluator, evaluated_at
     FROM teacher_evaluations WHERE teacher_id = ? AND year = ? AND month = ?`
  ).bind(teacherId, year, month).first();

  const rate = Number(t.rate_per_10min_php || 0);
  const monthlySalary = Math.round(classCount * 2 * rate * 100) / 100;
  const weighted = ev ? (ev.weighted_total != null ? Number(ev.weighted_total) : calcWeightedTotal(ev)) : null;
  const grade = weighted != null ? classifyEvalGrade(weighted) : '미평가';

  return {
    ok: true,
    teacher_id: t.id,
    teacher_name: t.name,
    status: t.status || null,
    years: t.years != null ? Number(t.years) : null,
    rate_per_10min_php: rate,
    year, month,
    class_count: classCount,
    monthly_salary_php: monthlySalary,
    monthly_salary_krw: Math.round(monthlySalary * PAYROLL_PHP_TO_KRW),
    php_to_krw: PAYROLL_PHP_TO_KRW,
    evaluation: ev ? {
      score_instruction:  ev.score_instruction,
      score_retention:    ev.score_retention,
      score_punctuality:  ev.score_punctuality,
      score_admin:        ev.score_admin,
      score_contribution: ev.score_contribution,
      weighted_total:     weighted,
      grade,
      strengths:          ev.strengths,
      improvements:       ev.improvements,
      evaluator:          ev.evaluator,
      evaluated_at:       ev.evaluated_at,
    } : null,
    weighted_total: weighted,
    grade,
    currency: 'PHP'
  };
}

/**
 * CSV 응답 헬퍼 — 다운로드 헤더 포함.
 */
function csvResponse(filename: string, csv: string): Response {
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// ========================================================================
// 📣 알림 큐 (Phase 5) — Worker 는 적재만 하고, 발송은 외부 도구가 폴링.
//   - 카카오톡 직접 발송은 후속 Phase (KAKAO_ACCESS_TOKEN 시크릿 도입) 에서.
//   - 큐 모델은 다채널 확장 가능 (slack/email/discord 등).
// ========================================================================
let _notifSchemaReady = false;
async function ensureNotifSchema(env: { DB: D1Database }): Promise<void> {
  if (_notifSchemaReady) return;
  // exec() 는 multi-statement DDL 용. IF NOT EXISTS 로 멱등.
  await env.DB.exec([
    `CREATE TABLE IF NOT EXISTS notification_queue (`,
    `  id INTEGER PRIMARY KEY AUTOINCREMENT,`,
    `  type TEXT NOT NULL,`,
    `  title TEXT,`,
    `  body TEXT,`,
    `  meta TEXT,`,
    `  channel TEXT DEFAULT 'kakao_memo',`,
    `  status TEXT DEFAULT 'pending',`,
    `  created_at INTEGER NOT NULL,`,
    `  sent_at INTEGER,`,
    `  error TEXT`,
    `);`
  ].join(' '));
  await env.DB.exec(
    `CREATE INDEX IF NOT EXISTS idx_notif_status_created ON notification_queue(status, created_at);`
  );
  _notifSchemaReady = true;
}

/**
 * 운영 이벤트를 알림 큐에 적재.
 *   - 적재 자체가 실패해도 호출 측 핵심 동작(출석 INSERT 등)을 막지 않도록
 *     try/catch 로 감싸서 console.warn 만 남기고 무시.
 */
async function enqueueNotification(
  env: { DB: D1Database },
  evt: { type: string; title: string; body: string; meta?: any; channel?: string }
): Promise<void> {
  try {
    await ensureNotifSchema(env);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO notification_queue (type, title, body, meta, channel, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    ).bind(
      evt.type,
      evt.title,
      evt.body,
      evt.meta ? JSON.stringify(evt.meta) : null,
      evt.channel || 'kakao_memo',
      now
    ).run();
  } catch (e: any) {
    console.warn('[notify] enqueue 실패 (무시하고 계속):', e?.message || e);
  }
}

export async function handleMangoApi(
  request: Request,
  url: URL,
  env: MangoEnv
): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  try {
    // ===== 출석 =====
    if (path === '/api/attendance/join' && method === 'POST') {
      const b = await parseJsonBody(request);
      if (!b || !b.room_id || !b.user_id) return invalidBody(['room_id', 'user_id']);
      const now = Date.now();
      const date = today(now);
      // 📣 오늘 처음 보는 (room_id, date) 조합이면 "수업 시작" 알림 큐에 적재
      //    INSERT 와 별개 트랜잭션 — 알림 실패가 출석 기록을 막지 않도록.
      const existing = await env.DB.prepare(
        `SELECT 1 FROM attendance WHERE room_id = ? AND date = ? LIMIT 1`
      ).bind(b.room_id, date).first();
      const res = await env.DB.prepare(
        `INSERT INTO attendance (room_id, user_id, username, role, joined_at, status, date)
         VALUES (?, ?, ?, ?, ?, 'present', ?)`
      ).bind(b.room_id, b.user_id, b.username || null, b.role || 'student', now, date).run();
      if (!existing) {
        await enqueueNotification(env, {
          type: 'class_start',
          title: `🎬 수업 시작 — 방 ${b.room_id}`,
          body: `${b.username || b.user_id} 님 입장 (${b.role || 'student'})`,
          meta: { room_id: b.room_id, user_id: b.user_id, role: b.role || 'student', joined_at: now }
        });
      }
      return json({ ok: true, attendance_id: res.meta.last_row_id, joined_at: now });
    }

    if (path === '/api/attendance/leave' && method === 'POST') {
      const b = await parseJsonBody(request);
      if (!b || !b.room_id || !b.user_id) return invalidBody(['room_id', 'user_id']);
      const now = Date.now();
      // 가장 최근 미종료 row 업데이트
      await env.DB.prepare(
        `UPDATE attendance
         SET left_at = ?,
             total_active_ms = COALESCE(?, total_active_ms),
             total_session_ms = COALESCE(?, total_session_ms),
             disconnect_count = COALESCE(?, disconnect_count),
             status = ?
         WHERE id = (
           SELECT id FROM attendance
           WHERE room_id = ? AND user_id = ? AND left_at IS NULL
           ORDER BY joined_at DESC LIMIT 1
         )`
      ).bind(
        now,
        b.total_active_ms ?? null,
        b.total_session_ms ?? null,
        b.disconnect_count ?? null,
        b.status || 'left',
        b.room_id,
        b.user_id
      ).run();
      return json({ ok: true, left_at: now });
    }

    if (path === '/api/attendance/heartbeat' && method === 'POST') {
      const b = await parseJsonBody(request);
      if (!b || !b.room_id || !b.user_id) return invalidBody(['room_id', 'user_id']);
      // KV에 마지막 heartbeat 저장 (60초 TTL)
      const key = `hb:${b.room_id}:${b.user_id}`;
      await env.SESSION_STATE.put(key, String(Date.now()), { expirationTtl: 60 });
      return json({ ok: true });
    }

    // ===== 발화시간 =====
    if (path === '/api/speaking-time' && method === 'POST') {
      const b = await parseJsonBody(request);
      if (!b || !b.room_id || !b.user_id) return invalidBody(['room_id', 'user_id']);
      const now = Date.now();
      await env.DB.prepare(
        `UPDATE attendance
         SET total_active_ms = ?, total_session_ms = ?
         WHERE id = (
           SELECT id FROM attendance
           WHERE room_id = ? AND user_id = ? AND left_at IS NULL
           ORDER BY joined_at DESC LIMIT 1
         )`
      ).bind(b.total_active_ms || 0, b.total_session_ms || 0, b.room_id, b.user_id).run();
      return json({ ok: true, recorded_at: now });
    }

    // ===== 시선 점수 =====
    //  - public/js/mango-gaze.js 가 10초마다 호출
    //  - session_* 필드가 있으면 그걸 누적값으로 사용(권장)
    //  - 없으면 이번 윈도우의 forward_samples/samples 로 단순 덮어쓰기
    //  - 같은 (room_id, user_id) 의 가장 최신 attendance row 를 업데이트
    if (path === '/api/gaze-score' && method === 'POST') {
      const b = await request.json() as any;
      if (!b.room_id || !b.user_id) {
        return json({ ok: false, error: 'room_id and user_id required' }, 400);
      }
      const now = Date.now();
      const cameraOff = b.camera_off === true;

      // 점수/샘플 결정: session_* 가 들어왔으면 누적값으로, 아니면 윈도우값 사용
      const totalSamples = (typeof b.session_samples === 'number')
        ? b.session_samples
        : Number(b.samples || 0);
      const forwardSamples = (typeof b.session_forward_samples === 'number')
        ? b.session_forward_samples
        : Number(b.forward_samples || 0);
      let score: number | null = null;
      if (cameraOff) {
        // 카메라 OFF 신호 → 점수는 null 로 유지 (admin 에서 "—" 로 보이되 샘플=0 으로 원인 구분 가능)
        score = null;
      } else if (typeof b.session_score === 'number' && !Number.isNaN(b.session_score)) {
        score = b.session_score;
      } else if (typeof b.gaze_score === 'number' && !Number.isNaN(b.gaze_score)) {
        score = b.gaze_score;
      } else if (totalSamples > 0) {
        score = Math.round((forwardSamples / totalSamples) * 1000) / 10;
      }

      // 가장 최근 열린 attendance row 우선, 없으면 가장 최근 row 로 fallback
      // (heartbeat 타이밍/예상치 못한 leave 순서 문제로 left_at 이 먼저 찍힌 경우 대비)
      const targetRow = await env.DB.prepare(
        `SELECT id, gaze_score FROM attendance
         WHERE room_id = ? AND user_id = ?
         ORDER BY (CASE WHEN left_at IS NULL THEN 0 ELSE 1 END), joined_at DESC
         LIMIT 1`
      ).bind(b.room_id, b.user_id).first<{ id: number; gaze_score: number | null }>();

      if (!targetRow) {
        // attendance row 자체가 없으면(이례적) 하나 만들어둔다 — 점수 보고가 유실되지 않도록.
        const date = today(now);
        const res = await env.DB.prepare(
          `INSERT INTO attendance (room_id, user_id, username, role, joined_at, status, date,
             gaze_score, gaze_samples, gaze_forward_samples)
           VALUES (?, ?, ?, ?, ?, 'present', ?, ?, ?, ?)`
        ).bind(
          b.room_id, b.user_id, b.username || null, b.role || 'student',
          now, date,
          score, totalSamples, forwardSamples
        ).run();
        return json({
          ok: true, attendance_id: res.meta.last_row_id,
          gaze_score: score, bootstrapped: true, camera_off: cameraOff
        });
      }

      // 카메라 OFF 신호인 경우엔 기존에 유효한 score 가 있다면 덮어쓰지 않음
      // (중간에 카메라를 잠깐 끈 경우에도 이전 측정치를 보존)
      if (cameraOff && targetRow.gaze_score !== null && targetRow.gaze_score !== undefined) {
        await env.DB.prepare(
          `UPDATE attendance
             SET gaze_samples = ?, gaze_forward_samples = ?
           WHERE id = ?`
        ).bind(totalSamples, forwardSamples, targetRow.id).run();
        return json({
          ok: true, attendance_id: targetRow.id,
          gaze_score: targetRow.gaze_score,
          camera_off: true, preserved_previous: true
        });
      }

      await env.DB.prepare(
        `UPDATE attendance
         SET gaze_score = ?,
             gaze_samples = ?,
             gaze_forward_samples = ?
         WHERE id = ?`
      ).bind(score, totalSamples, forwardSamples, targetRow.id).run();
      return json({
        ok: true, attendance_id: targetRow.id,
        gaze_score: score, camera_off: cameraOff, recorded_at: now
      });
    }

    // ===== 카카오 ID =====
    if (path === '/api/kakao-id' && method === 'POST') {
      const b = await parseJsonBody(request);
      if (!b || !b.user_id) return invalidBody(['user_id']);
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO kakao_ids (user_id, role, username, kakao_id, phone, opted_in_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           kakao_id = excluded.kakao_id,
           phone = excluded.phone,
           username = excluded.username,
           role = excluded.role,
           updated_at = excluded.updated_at`
      ).bind(b.user_id, b.role || 'teacher', b.username || null, b.kakao_id || null, b.phone || null, now, now).run();
      return json({ ok: true });
    }

    if (path.startsWith('/api/kakao-id/') && method === 'GET') {
      const userId = decodeURIComponent(path.replace('/api/kakao-id/', ''));
      const row = await env.DB.prepare(
        `SELECT user_id, role, username, kakao_id, phone, opted_in_at FROM kakao_ids WHERE user_id = ?`
      ).bind(userId).first();
      return json(row || null);
    }

    if (path === '/api/kakao-id/teachers' && method === 'GET') {
      const rs = await env.DB.prepare(
        `SELECT user_id, username, kakao_id, phone FROM kakao_ids WHERE role = 'teacher' AND kakao_id IS NOT NULL`
      ).all();
      return json(rs.results || []);
    }

    // ===== 비상 이벤트 =====
    if (path === '/api/emergency' && method === 'POST') {
      const b = await parseJsonBody(request);
      if (!b || !b.room_id || !b.user_id) {
        return invalidBody(['room_id', 'user_id']);
      }
      const now = Date.now();
      const res = await env.DB.prepare(
        `INSERT INTO emergency_events (room_id, user_id, target_user_id, event_type, triggered_at, meta)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(b.room_id, b.user_id, b.target_user_id || null, b.event_type || 'kakao_button', now, JSON.stringify(b.meta || {})).run();
      // 📣 비상 이벤트는 항상 즉시 알림
      await enqueueNotification(env, {
        type: 'emergency',
        title: `🚨 비상 이벤트 — 방 ${b.room_id}`,
        body: `${b.user_id} 가 ${b.event_type || 'kakao_button'} 트리거 (대상: ${b.target_user_id || '전체'})`,
        meta: { room_id: b.room_id, user_id: b.user_id, target_user_id: b.target_user_id || null, event_type: b.event_type || 'kakao_button', triggered_at: now, emergency_id: res.meta.last_row_id }
      });
      return json({ ok: true, id: res.meta.last_row_id });
    }

    // ===== 보상 =====
    if (path === '/api/reward' && method === 'POST') {
      const b = await parseJsonBody(request);
      if (!b || !b.teacher_id || !b.student_id || !b.type) {
        return invalidBody(['teacher_id', 'student_id', 'type']);
      }
      const now = Date.now();
      const date = today(now);
      const DAILY_LIMIT = 30; // 교사당 일일 발급 상한 (v3 §9)
      // 일일 상한 체크
      const limitRow = await env.DB.prepare(
        `SELECT count FROM reward_limits WHERE teacher_id = ? AND date = ?`
      ).bind(b.teacher_id, date).first<{ count: number }>();
      const currentCount = limitRow?.count || 0;
      if (currentCount >= DAILY_LIMIT) {
        return json({ ok: false, error: 'daily_limit_exceeded', limit: DAILY_LIMIT, current: currentCount }, 429);
      }
      const expiresAt = b.expires_at || (now + 90 * 24 * 3600 * 1000); // 90일
      const res = await env.DB.prepare(
        `INSERT INTO rewards (teacher_id, student_id, room_id, type, value, message, issued_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(b.teacher_id, b.student_id, b.room_id || null, b.type, b.value || null, b.message || null, now, expiresAt).run();
      // 카운트 증가
      await env.DB.prepare(
        `INSERT INTO reward_limits (teacher_id, date, count) VALUES (?, ?, 1)
         ON CONFLICT(teacher_id, date) DO UPDATE SET count = count + 1`
      ).bind(b.teacher_id, date).run();
      return json({ ok: true, reward_id: res.meta.last_row_id, daily_remaining: DAILY_LIMIT - currentCount - 1 });
    }

    if (path.startsWith('/api/rewards/student/') && method === 'GET') {
      const studentId = decodeURIComponent(path.replace('/api/rewards/student/', ''));
      const rs = await env.DB.prepare(
        `SELECT id, teacher_id, type, value, message, issued_at, expires_at, status
         FROM rewards WHERE student_id = ? AND status = 'active'
         ORDER BY issued_at DESC LIMIT 100`
      ).bind(studentId).all();
      return json(rs.results || []);
    }

    // ===== 대시보드 =====
    if (path === '/api/dashboard' && method === 'GET') {
      const days = parseInt(url.searchParams.get('days') || '7', 10);
      const since = Date.now() - days * 24 * 3600 * 1000;

      const [attTotal, attByDay, disconnectStats, emergencyCount, rewardCount, topSpeakers] = await Promise.all([
        env.DB.prepare(`SELECT COUNT(*) AS c FROM attendance WHERE joined_at >= ?`).bind(since).first(),
        env.DB.prepare(
          `SELECT date, COUNT(DISTINCT user_id) AS unique_users, COUNT(*) AS sessions
           FROM attendance WHERE joined_at >= ? GROUP BY date ORDER BY date DESC`
        ).bind(since).all(),
        env.DB.prepare(
          `SELECT COUNT(*) AS total_sessions,
                  SUM(disconnect_count) AS total_disconnects,
                  AVG(CASE WHEN total_session_ms > 0 THEN (total_active_ms*100.0/total_session_ms) ELSE 0 END) AS avg_active_pct
           FROM attendance WHERE joined_at >= ?`
        ).bind(since).first(),
        env.DB.prepare(`SELECT COUNT(*) AS c, event_type FROM emergency_events WHERE triggered_at >= ? GROUP BY event_type`).bind(since).all(),
        env.DB.prepare(`SELECT COUNT(*) AS c, type FROM rewards WHERE issued_at >= ? GROUP BY type`).bind(since).all(),
        env.DB.prepare(
          `SELECT user_id, username, SUM(total_active_ms) AS active_ms, SUM(total_session_ms) AS session_ms
           FROM attendance WHERE joined_at >= ? AND total_session_ms > 0
           GROUP BY user_id ORDER BY active_ms DESC LIMIT 10`
        ).bind(since).all()
      ]);

      return json({
        period_days: days,
        attendance: {
          total: (attTotal as any)?.c || 0,
          by_day: attByDay.results || []
        },
        connection: disconnectStats || {},
        emergency: emergencyCount.results || [],
        rewards: rewardCount.results || [],
        top_speakers: topSpeakers.results || []
      });
    }

    // ===== 관리자 개입: 수업 강제 종료 (Phase 4) =====
    //   POST /api/admin/room/:roomId/force-end
    //     - 해당 room 의 VideoCallRoom DO 에 /force-end 를 위임
    //     - DO 가 모든 연결에 force_end 브로드캐스트 + close
    if (method === 'POST' && /^\/api\/admin\/room\/[^/]+\/force-end$/.test(path)) {
      const m = path.match(/^\/api\/admin\/room\/([^/]+)\/force-end$/);
      const roomId = m ? decodeURIComponent(m[1]) : '';
      if (!roomId) return invalidBody(['room_id(path)']);
      const envAny = env as any;
      if (!envAny.VIDEO_CALL_ROOM) {
        return json({ ok: false, error: 'VIDEO_CALL_ROOM binding missing' }, 500);
      }
      const doId = envAny.VIDEO_CALL_ROOM.idFromName(roomId);
      const stub = envAny.VIDEO_CALL_ROOM.get(doId);
      // body 로 reason 전달 가능 — 없으면 기본 문구
      const b = await parseJsonBody(request);
      const reason = (b && typeof b.reason === 'string' && b.reason.trim()) ? b.reason.trim() : '관리자가 수업을 종료했습니다.';
      const resp = await stub.fetch('http://do/force-end?reason=' + encodeURIComponent(reason), { method: 'POST' });
      const body = await resp.text();
      // 📣 강제 종료는 운영 액션 — 알림 큐 적재
      let parsed: any = null; try { parsed = JSON.parse(body); } catch {}
      await enqueueNotification(env, {
        type: 'class_force_end',
        title: `🛑 수업 강제 종료 — 방 ${roomId}`,
        body: `사유: ${reason} · 알림 ${parsed?.notified ?? '?'}명`,
        meta: { room_id: roomId, reason, notified: parsed?.notified ?? null, ended_at: Date.now() }
      });
      return new Response(body, {
        status: resp.status,
        headers: {
          'Content-Type': resp.headers.get('Content-Type') || 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // ===== 📣 알림 큐 (Phase 5) =====
    //   GET   /api/admin/notifications?status=pending&limit=50
    //   POST  /api/admin/notifications/test     (관리자가 임의 메시지 큐에 적재 — 검증용)
    //   PATCH /api/admin/notifications/:id      body: { status: 'sent'|'failed'|'discarded', error?: string }
    if (path === '/api/admin/notifications' && method === 'GET') {
      await ensureNotifSchema(env);
      const wantStatus = url.searchParams.get('status') || 'pending';
      const lim = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') || '50', 10)));
      let rs;
      if (wantStatus === 'all') {
        rs = await env.DB.prepare(
          `SELECT id, type, title, body, meta, channel, status, created_at, sent_at, error
           FROM notification_queue ORDER BY created_at DESC LIMIT ?`
        ).bind(lim).all();
      } else {
        rs = await env.DB.prepare(
          `SELECT id, type, title, body, meta, channel, status, created_at, sent_at, error
           FROM notification_queue WHERE status = ? ORDER BY created_at DESC LIMIT ?`
        ).bind(wantStatus, lim).all();
      }
      // 카운트 (status 별 합계)
      const countRs = await env.DB.prepare(
        `SELECT status, COUNT(*) AS c FROM notification_queue GROUP BY status`
      ).all();
      const counts: any = {};
      for (const row of (countRs.results || []) as any[]) counts[row.status] = row.c;
      return json({ ok: true, items: rs.results || [], counts });
    }

    if (path === '/api/admin/notifications/test' && method === 'POST') {
      const b = await parseJsonBody(request);
      const title = (b && b.title) || '🧪 테스트 알림';
      const body  = (b && b.body)  || '알림 큐 동작 검증용 메시지입니다.';
      await enqueueNotification(env, { type: 'manual', title, body, meta: { issued_by: 'admin', at: Date.now() } });
      return json({ ok: true, enqueued: { title, body } });
    }

    if (method === 'PATCH' && /^\/api\/admin\/notifications\/\d+$/.test(path)) {
      await ensureNotifSchema(env);
      const m = path.match(/^\/api\/admin\/notifications\/(\d+)$/);
      const id = m ? parseInt(m[1], 10) : 0;
      if (!id) return invalidBody(['id(path)']);
      const b = await parseJsonBody(request);
      if (!b || !b.status) return invalidBody(['status']);
      const allowed = new Set(['sent', 'failed', 'discarded', 'pending']);
      if (!allowed.has(b.status)) {
        return json({ ok: false, error: 'invalid_status', allowed: Array.from(allowed) }, 400);
      }
      const sentAt = b.status === 'sent' ? Date.now() : null;
      await env.DB.prepare(
        `UPDATE notification_queue SET status = ?, sent_at = ?, error = ? WHERE id = ?`
      ).bind(b.status, sentAt, b.error || null, id).run();
      return json({ ok: true, id, status: b.status, sent_at: sentAt });
    }

    // ===== 📥 CSV 내보내기 (Phase 6) =====
    //   GET /api/admin/export/recordings.csv?q=&date_from=&date_to=&status=
    //   GET /api/admin/export/attendance.csv?date_from=&date_to=&user_id=&room_id=
    //   - 기존 /api/recordings 검색 파라미터 동일하게 받음
    //   - LIMIT 10000 (실무 용도). 더 크면 페이징 필요하지만 일반 사례에선 충분.
    if (method === 'GET' && path === '/api/admin/export/recordings.csv') {
      const qSearch  = (url.searchParams.get('q') || '').trim();
      const dateFrom = url.searchParams.get('date_from');
      const dateTo   = url.searchParams.get('date_to');
      const statusF  = url.searchParams.get('status');
      const where: string[] = [];
      const binds: any[] = [];
      if (qSearch) {
        where.push("(r.room_id LIKE ? OR COALESCE(r.teacher_name,'') LIKE ? OR COALESCE(r.teacher_id,'') LIKE ?)");
        const p = `%${qSearch}%`;
        binds.push(p, p, p);
      }
      if (dateFrom) {
        const ms = Date.parse(dateFrom + 'T00:00:00+09:00');
        if (!isNaN(ms)) { where.push('r.started_at >= ?'); binds.push(ms); }
      }
      if (dateTo) {
        const ms = Date.parse(dateTo + 'T23:59:59+09:00');
        if (!isNaN(ms)) { where.push('r.started_at <= ?'); binds.push(ms); }
      }
      if (statusF && statusF !== 'all') { where.push('r.status = ?'); binds.push(statusF); }
      const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const sql = `SELECT r.id, r.room_id, r.teacher_id, r.teacher_name, r.started_at, r.ended_at,
                          r.duration_ms, r.size_bytes, r.status, r.storage,
                          r.participant_names, r.consented_user_ids
                   FROM recordings r ${whereSQL}
                   ORDER BY r.started_at DESC LIMIT 10000`;
      const rs = binds.length
        ? await env.DB.prepare(sql).bind(...binds).all()
        : await env.DB.prepare(sql).all();
      // ms epoch → ISO 문자열 변환 (CSV 가독성)
      const rows = ((rs.results || []) as any[]).map(r => ({
        ...r,
        started_at_iso: r.started_at ? new Date(r.started_at).toISOString() : '',
        ended_at_iso:   r.ended_at   ? new Date(r.ended_at).toISOString()   : '',
        duration_sec:   r.duration_ms ? Math.round(r.duration_ms / 1000) : 0,
        size_mb:        r.size_bytes  ? Math.round(r.size_bytes / 1024 / 1024 * 10) / 10 : 0
      }));
      const csv = toCSV(rows, [
        { key: 'id',                label: 'id' },
        { key: 'room_id',           label: 'room_id' },
        { key: 'teacher_id',        label: 'teacher_id' },
        { key: 'teacher_name',      label: 'teacher_name' },
        { key: 'started_at_iso',    label: 'started_at' },
        { key: 'ended_at_iso',      label: 'ended_at' },
        { key: 'duration_sec',      label: 'duration_sec' },
        { key: 'size_mb',           label: 'size_mb' },
        { key: 'status',            label: 'status' },
        { key: 'storage',           label: 'storage' },
        { key: 'participant_names', label: 'participant_names' },
        { key: 'consented_user_ids',label: 'consented_user_ids' }
      ]);
      const fname = 'recordings_' + new Date().toISOString().slice(0, 10) + '.csv';
      return csvResponse(fname, csv);
    }

    if (method === 'GET' && path === '/api/admin/export/attendance.csv') {
      const dateFrom = url.searchParams.get('date_from');
      const dateTo   = url.searchParams.get('date_to');
      const userId   = url.searchParams.get('user_id');
      const roomId   = url.searchParams.get('room_id');
      const where: string[] = [];
      const binds: any[] = [];
      if (dateFrom) {
        const ms = Date.parse(dateFrom + 'T00:00:00+09:00');
        if (!isNaN(ms)) { where.push('a.joined_at >= ?'); binds.push(ms); }
      }
      if (dateTo) {
        const ms = Date.parse(dateTo + 'T23:59:59+09:00');
        if (!isNaN(ms)) { where.push('a.joined_at <= ?'); binds.push(ms); }
      }
      if (userId) { where.push('a.user_id = ?'); binds.push(userId); }
      if (roomId) { where.push('a.room_id = ?'); binds.push(roomId); }
      const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const sql = `SELECT a.id, a.room_id, a.user_id, a.username, a.role,
                          a.joined_at, a.left_at, a.status, a.date,
                          a.total_session_ms, a.total_active_ms, a.disconnect_count,
                          a.gaze_score, a.gaze_samples, a.gaze_forward_samples
                   FROM attendance a ${whereSQL}
                   ORDER BY a.joined_at DESC LIMIT 10000`;
      const rs = binds.length
        ? await env.DB.prepare(sql).bind(...binds).all()
        : await env.DB.prepare(sql).all();
      const rows = ((rs.results || []) as any[]).map(a => ({
        ...a,
        joined_at_iso: a.joined_at ? new Date(a.joined_at).toISOString() : '',
        left_at_iso:   a.left_at   ? new Date(a.left_at).toISOString()   : '',
        active_pct:    a.total_session_ms > 0 ? Math.round((a.total_active_ms / a.total_session_ms) * 1000) / 10 : 0,
        session_min:   a.total_session_ms ? Math.round(a.total_session_ms / 60000 * 10) / 10 : 0,
        active_min:    a.total_active_ms  ? Math.round(a.total_active_ms  / 60000 * 10) / 10 : 0
      }));
      const csv = toCSV(rows, [
        { key: 'id',                   label: 'id' },
        { key: 'date',                 label: 'date' },
        { key: 'room_id',              label: 'room_id' },
        { key: 'user_id',              label: 'user_id' },
        { key: 'username',             label: 'username' },
        { key: 'role',                 label: 'role' },
        { key: 'joined_at_iso',        label: 'joined_at' },
        { key: 'left_at_iso',          label: 'left_at' },
        { key: 'status',               label: 'status' },
        { key: 'session_min',          label: 'session_min' },
        { key: 'active_min',           label: 'active_min' },
        { key: 'active_pct',           label: 'active_pct' },
        { key: 'disconnect_count',     label: 'disconnect_count' },
        { key: 'gaze_score',           label: 'gaze_score' },
        { key: 'gaze_samples',         label: 'gaze_samples' },
        { key: 'gaze_forward_samples', label: 'gaze_forward_samples' }
      ]);
      const fname = 'attendance_' + new Date().toISOString().slice(0, 10) + '.csv';
      return csvResponse(fname, csv);
    }

    // ===== 💰 저장소·비용 통계 (Phase 7) =====
    //   GET /api/admin/stats/storage
    //   - D1 테이블별 row 수 + 녹화 총 size_bytes
    //   - R2 객체 수·총 size (list 페이지 최대 5장 = 5000 객체)
    //   - KV 는 list() 가 일일 한도 소비라 측정 제외 (dashboard 안내)
    if (method === 'GET' && path === '/api/admin/stats/storage') {
      const started = Date.now();

      // D1 비즈니스 메트릭 — 병렬 조회. notification_queue 는 미생성 환경에서 fail 가능 → catch
      const safe = (p: Promise<any>) => p.catch(() => null);
      const [recCount, recSize, recByStatus, attCount, attTotals, emergCount, rewardCount, notifByStatus] = await Promise.all([
        safe(env.DB.prepare(`SELECT COUNT(*) AS c FROM recordings`).first()),
        safe(env.DB.prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS total FROM recordings`).first()),
        safe(env.DB.prepare(`SELECT status, COUNT(*) AS c FROM recordings GROUP BY status`).all()),
        safe(env.DB.prepare(`SELECT COUNT(*) AS c FROM attendance`).first()),
        safe(env.DB.prepare(`SELECT COALESCE(SUM(total_session_ms), 0) AS total_session, COALESCE(SUM(total_active_ms), 0) AS total_active FROM attendance`).first()),
        safe(env.DB.prepare(`SELECT COUNT(*) AS c FROM emergency_events`).first()),
        safe(env.DB.prepare(`SELECT COUNT(*) AS c FROM rewards`).first()),
        safe(env.DB.prepare(`SELECT status, COUNT(*) AS c FROM notification_queue GROUP BY status`).all())
      ]);

      // R2 객체 카운트 (최대 5,000 개) — 더 크면 truncated=true 로 알림
      let r2Count = 0;
      let r2Size = 0;
      let r2Truncated = false;
      const envAny = env as any;
      if (envAny.RECORDINGS) {
        try {
          let cursor: string | undefined = undefined;
          const MAX_PAGES = 5;
          for (let i = 0; i < MAX_PAGES; i++) {
            const ls: any = await envAny.RECORDINGS.list({ limit: 1000, cursor });
            for (const obj of (ls.objects || [])) {
              r2Count++;
              r2Size += obj.size || 0;
            }
            if (ls.truncated && ls.cursor) {
              cursor = ls.cursor;
              if (i === MAX_PAGES - 1) r2Truncated = true;
            } else { break; }
          }
        } catch (e) {
          // 측정 실패해도 D1 메트릭은 반환
        }
      }

      return json({
        ok: true,
        timestamp: Date.now(),
        latencyMs: Date.now() - started,
        d1: {
          recordings: {
            count: (recCount as any)?.c || 0,
            total_size_bytes: (recSize as any)?.total || 0,
            by_status: (recByStatus as any)?.results || []
          },
          attendance: {
            count: (attCount as any)?.c || 0,
            total_session_ms: (attTotals as any)?.total_session || 0,
            total_active_ms:  (attTotals as any)?.total_active  || 0
          },
          emergency_events: (emergCount as any)?.c || 0,
          rewards: (rewardCount as any)?.c || 0,
          notification_queue_by_status: (notifByStatus as any)?.results || []
        },
        r2: {
          configured: !!envAny.RECORDINGS,
          object_count: r2Count,
          total_size_bytes: r2Size,
          truncated: r2Truncated,
          note: r2Truncated ? '5,000 객체 초과 — 정확한 사용량은 Cloudflare dashboard 에서 확인' : null
        },
        kv: {
          note: 'KV 사용량(list/get/put 호출 수) 은 Cloudflare dashboard 에서 확인. list() 호출 자체가 일일 한도 소비라 셀프 측정 제외.'
        }
      });
    }

    // ===== 💼 강사 급여·평가 (Phase 8 v2: 10분단가 + 5카테고리 평가) =====

    // 시스템 설정 조회 (UI 안내용 — 환율, 가중치, 등급 임계값)
    if (method === 'GET' && path === '/api/admin/payroll/rates') {
      return json({
        ok: true,
        currency: 'PHP',
        php_to_krw: PAYROLL_PHP_TO_KRW,
        valid_status: VALID_TEACHER_STATUS,
        eval_weights: EVAL_WEIGHTS,
        grade_thresholds: [
          { grade: '최우수',    min: 4.75, max: 5.00 },
          { grade: '매우 우수', min: 4.50, max: 4.74 },
          { grade: '우수',      min: 3.50, max: 4.49 },
          { grade: '개선 요망', min: 1.00, max: 3.49 },
        ]
      });
    }

    // 강사 목록
    if (method === 'GET' && path === '/api/admin/teachers') {
      await ensurePayrollSchema(env);
      const includeInactive = url.searchParams.get('include_inactive') === '1';
      const sql = includeInactive
        ? `SELECT * FROM teachers ORDER BY active DESC, name ASC`
        : `SELECT * FROM teachers WHERE active = 1 ORDER BY name ASC`;
      const rs = await env.DB.prepare(sql).all();
      return json({ ok: true, items: rs.results || [] });
    }

    // 강사 등록 (새 모델: name + status + years + rate_per_10min_php)
    if (method === 'POST' && path === '/api/admin/teachers') {
      await ensurePayrollSchema(env);
      const b = await parseJsonBody(request);
      if (!b || !b.name || !b.status || b.rate_per_10min_php == null) {
        return invalidBody(['name', 'status', 'rate_per_10min_php']);
      }
      if (!VALID_TEACHER_STATUS.includes(b.status)) {
        return json({ ok: false, error: 'invalid_status', allowed: VALID_TEACHER_STATUS }, 400);
      }
      const rate = Number(b.rate_per_10min_php);
      if (isNaN(rate) || rate < 0) return json({ ok: false, error: 'invalid_rate' }, 400);
      const now = Date.now();
      const res = await env.DB.prepare(
        `INSERT INTO teachers (user_id, name, center_id, status, years, rate_per_10min_php, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
      ).bind(
        b.user_id || null, b.name, b.center_id || null,
        b.status, b.years != null ? Number(b.years) : null, rate,
        now, now
      ).run();
      return json({ ok: true, id: res.meta.last_row_id });
    }

    // 강사 수정 (부분 업데이트 — 모든 필드 선택적)
    if (method === 'PATCH' && /^\/api\/admin\/teachers\/\d+$/.test(path)) {
      await ensurePayrollSchema(env);
      const m = path.match(/^\/api\/admin\/teachers\/(\d+)$/);
      const id = m ? parseInt(m[1], 10) : 0;
      if (!id) return invalidBody(['id(path)']);
      const b = await parseJsonBody(request);
      if (!b) return invalidBody(['<any field>']);
      if (b.status && !VALID_TEACHER_STATUS.includes(b.status)) {
        return json({ ok: false, error: 'invalid_status', allowed: VALID_TEACHER_STATUS }, 400);
      }
      const sets: string[] = [];
      const binds: any[] = [];
      if (b.name !== undefined)               { sets.push('name = ?');               binds.push(b.name); }
      if (b.status !== undefined)             { sets.push('status = ?');             binds.push(b.status); }
      if (b.years !== undefined)              { sets.push('years = ?');              binds.push(b.years); }
      if (b.rate_per_10min_php !== undefined) { sets.push('rate_per_10min_php = ?'); binds.push(b.rate_per_10min_php); }
      if (b.center_id !== undefined)          { sets.push('center_id = ?');          binds.push(b.center_id); }
      if (b.active !== undefined)             { sets.push('active = ?');             binds.push(b.active ? 1 : 0); }
      if (sets.length === 0) return json({ ok: false, error: 'nothing_to_update' }, 400);
      sets.push('updated_at = ?'); binds.push(Date.now());
      binds.push(id);
      await env.DB.prepare(`UPDATE teachers SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
      return json({ ok: true, id });
    }

    // 월별 수업 수 입력 (20분 단위 수업 횟수)
    if (method === 'PUT' && path === '/api/admin/teacher-classes') {
      await ensurePayrollSchema(env);
      const b = await parseJsonBody(request);
      if (!b || !b.teacher_id || !b.year || !b.month || b.class_count == null) {
        return invalidBody(['teacher_id', 'year', 'month', 'class_count']);
      }
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO teacher_monthly_classes (teacher_id, year, month, class_count, notes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(teacher_id, year, month) DO UPDATE SET
           class_count = excluded.class_count, notes = excluded.notes, updated_at = excluded.updated_at`
      ).bind(b.teacher_id, b.year, b.month, Math.max(0, parseInt(b.class_count, 10) || 0), b.notes || null, now).run();
      return json({ ok: true });
    }

    // 월별 평가 입력 (5개 카테고리 점수 + 코멘트)
    if (method === 'PUT' && path === '/api/admin/teacher-evaluation') {
      await ensurePayrollSchema(env);
      const b = await parseJsonBody(request);
      if (!b || !b.teacher_id || !b.year || !b.month) return invalidBody(['teacher_id', 'year', 'month']);
      // 점수 범위 검증 (1~5, 빈 칸 허용)
      const fields = ['score_instruction', 'score_retention', 'score_punctuality', 'score_admin', 'score_contribution'] as const;
      const vals: Record<string, number | null> = {};
      for (const f of fields) {
        if (b[f] == null || b[f] === '') { vals[f] = null; continue; }
        const v = Number(b[f]);
        if (isNaN(v) || v < 1 || v > 5) return json({ ok: false, error: 'invalid_score', field: f, allowed: '1.0~5.0' }, 400);
        vals[f] = Math.round(v * 10) / 10;
      }
      const weighted = calcWeightedTotal(vals as any);
      const grade = weighted != null ? classifyEvalGrade(weighted) : null;
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO teacher_evaluations
           (teacher_id, year, month, score_instruction, score_retention, score_punctuality,
            score_admin, score_contribution, weighted_total, grade,
            strengths, improvements, evaluator, evaluated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(teacher_id, year, month) DO UPDATE SET
           score_instruction  = excluded.score_instruction,
           score_retention    = excluded.score_retention,
           score_punctuality  = excluded.score_punctuality,
           score_admin        = excluded.score_admin,
           score_contribution = excluded.score_contribution,
           weighted_total     = excluded.weighted_total,
           grade              = excluded.grade,
           strengths          = excluded.strengths,
           improvements       = excluded.improvements,
           evaluator          = excluded.evaluator,
           evaluated_at       = excluded.evaluated_at`
      ).bind(
        b.teacher_id, b.year, b.month,
        vals.score_instruction, vals.score_retention, vals.score_punctuality,
        vals.score_admin, vals.score_contribution, weighted, grade,
        b.strengths || null, b.improvements || null, b.evaluator || 'admin', now
      ).run();
      return json({ ok: true, weighted_total: weighted, grade });
    }

    // 개별 강사 월별 통합 조회 (계산 + 평가)
    if (method === 'GET' && /^\/api\/admin\/payroll\/\d+$/.test(path)) {
      await ensurePayrollSchema(env);
      const m = path.match(/^\/api\/admin\/payroll\/(\d+)$/);
      const id = m ? parseInt(m[1], 10) : 0;
      const year  = parseInt(url.searchParams.get('year')  || '0', 10);
      const month = parseInt(url.searchParams.get('month') || '0', 10);
      if (!id || !year || !month) return invalidBody(['teacher_id(path)', 'year', 'month']);
      const result = await calcPayrollOne(env, id, year, month);
      return json(result, result.ok ? 200 : 404);
    }

    // 일괄 — 활성 강사 전원 (월별 dashboard 용)
    if (method === 'GET' && path === '/api/admin/payroll/all') {
      await ensurePayrollSchema(env);
      const year  = parseInt(url.searchParams.get('year')  || '0', 10);
      const month = parseInt(url.searchParams.get('month') || '0', 10);
      if (!year || !month) return invalidBody(['year', 'month']);
      const rs = await env.DB.prepare(`SELECT id FROM teachers WHERE active = 1 ORDER BY name ASC`).all();
      const items: any[] = [];
      let totalPhp = 0;
      for (const t of (rs.results || []) as any[]) {
        const r = await calcPayrollOne(env, t.id, year, month);
        if (r.ok) { items.push(r); totalPhp += r.monthly_salary_php || 0; }
      }
      const totalKrw = Math.round(totalPhp * PAYROLL_PHP_TO_KRW);
      // 등급 분포 카운트
      const gradeCounts: Record<string, number> = {};
      for (const it of items) {
        const g = it.grade || '미평가';
        gradeCounts[g] = (gradeCounts[g] || 0) + 1;
      }
      return json({
        ok: true, year, month, count: items.length,
        total_salary_php: Math.round(totalPhp * 100) / 100,
        total_salary_krw: totalKrw,
        php_to_krw: PAYROLL_PHP_TO_KRW,
        grade_counts: gradeCounts,
        currency: 'PHP', items
      });
    }

    // 마감 (payslips 잠금)
    if (method === 'POST' && path === '/api/admin/payroll/finalize') {
      await ensurePayrollSchema(env);
      const b = await parseJsonBody(request);
      if (!b || !b.year || !b.month) return invalidBody(['year', 'month']);
      const finalizedBy = (b.finalized_by || 'admin').toString().slice(0, 64);
      const now = Date.now();
      const rs = await env.DB.prepare(`SELECT id FROM teachers WHERE active = 1`).all();
      let saved = 0, skipped = 0, totalPhp = 0;
      for (const t of (rs.results || []) as any[]) {
        const r = await calcPayrollOne(env, t.id, b.year, b.month);
        if (!r.ok) continue;
        try {
          await env.DB.prepare(
            `INSERT INTO payslips (teacher_id, year, month, status, class_count, rate_per_10min_php,
                                    monthly_salary_php, weighted_total, grade, finalized_at, finalized_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            r.teacher_id, r.year, r.month, r.status, r.class_count, r.rate_per_10min_php,
            r.monthly_salary_php, r.weighted_total, r.grade, now, finalizedBy
          ).run();
          saved++;
          totalPhp += r.monthly_salary_php || 0;
        } catch (e) { skipped++; }
      }
      await enqueueNotification(env, {
        type: 'payroll_finalized',
        title: `💼 ${b.year}-${String(b.month).padStart(2,'0')} 급여 마감`,
        body: `강사 ${saved}명 정산 완료 (skipped ${skipped}). 합계 PHP ${Math.round(totalPhp).toLocaleString()} ≈ KRW ${Math.round(totalPhp * PAYROLL_PHP_TO_KRW).toLocaleString()}.`,
        meta: { year: b.year, month: b.month, saved, skipped, total_php: totalPhp, php_to_krw: PAYROLL_PHP_TO_KRW, finalized_by: finalizedBy, finalized_at: now }
      });
      return json({ ok: true, year: b.year, month: b.month, saved, skipped, total_php: Math.round(totalPhp), finalized_by: finalizedBy });
    }

    // CSV — Mangoi 평가 + 급여 통합 (회계 + 평가팀 공용)
    if (method === 'GET' && path === '/api/admin/export/payroll.csv') {
      await ensurePayrollSchema(env);
      const year  = parseInt(url.searchParams.get('year')  || '0', 10);
      const month = parseInt(url.searchParams.get('month') || '0', 10);
      if (!year || !month) return invalidBody(['year', 'month']);
      const rs = await env.DB.prepare(`SELECT id FROM teachers WHERE active = 1 ORDER BY name ASC`).all();
      const rows: any[] = [];
      for (const t of (rs.results || []) as any[]) {
        const r = await calcPayrollOne(env, t.id, year, month);
        if (!r.ok) continue;
        const e = r.evaluation || {};
        rows.push({
          teacher_id:         r.teacher_id,
          teacher_name:       r.teacher_name,
          status:             r.status,
          years:              r.years,
          year:               r.year,
          month:              r.month,
          class_count:        r.class_count,
          rate_per_10min_php: r.rate_per_10min_php,
          monthly_salary_php: r.monthly_salary_php,
          monthly_salary_krw: r.monthly_salary_krw,
          score_instruction:  e.score_instruction,
          score_retention:    e.score_retention,
          score_punctuality:  e.score_punctuality,
          score_admin:        e.score_admin,
          score_contribution: e.score_contribution,
          weighted_total:     r.weighted_total,
          grade:              r.grade,
          strengths:          e.strengths,
          improvements:       e.improvements,
        });
      }
      const csv = toCSV(rows, [
        { key: 'teacher_id',         label: 'teacher_id' },
        { key: 'teacher_name',       label: 'teacher_name' },
        { key: 'status',             label: 'status' },
        { key: 'years',              label: 'years' },
        { key: 'year',               label: 'year' },
        { key: 'month',              label: 'month' },
        { key: 'class_count',        label: 'class_count_20min' },
        { key: 'rate_per_10min_php', label: 'rate_per_10min_php' },
        { key: 'monthly_salary_php', label: 'monthly_salary_php' },
        { key: 'monthly_salary_krw', label: 'monthly_salary_krw' },
        { key: 'score_instruction',  label: 'inst_25%' },
        { key: 'score_retention',    label: 'ret_30%' },
        { key: 'score_punctuality',  label: 'punct_20%' },
        { key: 'score_admin',        label: 'admin_15%' },
        { key: 'score_contribution', label: 'contrib_10%' },
        { key: 'weighted_total',     label: 'weighted_total' },
        { key: 'grade',              label: 'grade' },
        { key: 'strengths',          label: 'strengths' },
        { key: 'improvements',       label: 'improvements' },
      ]);
      const fname = `mangoi_payroll_${year}-${String(month).padStart(2,'0')}.csv`;
      return csvResponse(fname, csv);
    }

    // ===== 관리자 개입: 녹화 상태 변경 (Phase 4) =====
    //   PATCH /api/recordings/:id/status  body: { status: 'ended' | 'deleted' }
    //     - 기존 DELETE /api/recordings/:id 는 deleted 로만 변경 가능 → 복원(ended) 을 이걸로 처리
    if (method === 'PATCH' && /^\/api\/recordings\/\d+\/status$/.test(path)) {
      const m = path.match(/^\/api\/recordings\/(\d+)\/status$/);
      const id = m ? parseInt(m[1], 10) : 0;
      if (!id) return invalidBody(['id(path)']);
      const b = await parseJsonBody(request);
      if (!b || !b.status) return invalidBody(['status']);
      const allowed = new Set(['ended', 'deleted', 'aborted']);
      if (!allowed.has(b.status)) {
        return json({ ok: false, error: 'invalid_status', allowed: Array.from(allowed) }, 400);
      }
      await env.DB.prepare(`UPDATE recordings SET status = ? WHERE id = ?`).bind(b.status, id).run();
      return json({ ok: true, id, status: b.status });
    }

    // ===== 학생별 드릴다운 (Phase 2) =====
    //   GET /api/admin/student/:user_id?days=30
    //   - 프로필 (최초/마지막 접속, 전체 세션 수)
    //   - 요약 (기간 내 집계)
    //   - 일자별 by_day (차트용)
    //   - 세션 리스트 (최근순)
    if (path.startsWith('/api/admin/student/') && method === 'GET') {
      const userId = decodeURIComponent(path.replace('/api/admin/student/', ''));
      if (!userId) return invalidBody(['user_id(path)']);
      const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get('days') || '30', 10)));
      const since = Date.now() - days * 24 * 3600 * 1000;

      const [profileRow, summaryRow, byDayRows, sessionRows] = await Promise.all([
        // 프로필: 기간 무관 전체 history
        env.DB.prepare(
          `SELECT user_id, COALESCE(MAX(username), user_id) AS username, COALESCE(MAX(role), 'student') AS role,
                  MIN(joined_at) AS first_seen, MAX(joined_at) AS last_seen,
                  COUNT(*) AS total_sessions_all_time
           FROM attendance WHERE user_id = ?`
        ).bind(userId).first(),
        // 요약: 기간 내 집계
        env.DB.prepare(
          `SELECT COUNT(*) AS session_count,
                  COALESCE(SUM(total_session_ms), 0) AS total_session_ms,
                  COALESCE(SUM(total_active_ms), 0)  AS total_active_ms,
                  COALESCE(SUM(disconnect_count), 0) AS disconnect_sum,
                  AVG(CASE WHEN gaze_score IS NOT NULL THEN gaze_score END) AS avg_gaze_score,
                  COUNT(CASE WHEN gaze_score IS NOT NULL THEN 1 END) AS gaze_score_count
           FROM attendance WHERE user_id = ? AND joined_at >= ?`
        ).bind(userId, since).first(),
        // 일자별 (차트용)
        env.DB.prepare(
          `SELECT date,
                  COUNT(*) AS session_count,
                  COALESCE(SUM(total_session_ms), 0) AS total_session_ms,
                  COALESCE(SUM(total_active_ms), 0)  AS total_active_ms,
                  AVG(CASE WHEN gaze_score IS NOT NULL THEN gaze_score END) AS avg_gaze_score
           FROM attendance WHERE user_id = ? AND joined_at >= ?
           GROUP BY date ORDER BY date ASC`
        ).bind(userId, since).all(),
        // 세션 리스트 (최근순)
        env.DB.prepare(
          `SELECT id, room_id, joined_at, left_at, status, date,
                  total_session_ms, total_active_ms, disconnect_count,
                  gaze_score, gaze_samples, gaze_forward_samples
           FROM attendance WHERE user_id = ? AND joined_at >= ?
           ORDER BY joined_at DESC LIMIT 200`
        ).bind(userId, since).all()
      ]);

      if (!profileRow || !(profileRow as any).user_id) {
        return json({ ok: false, error: 'student_not_found', user_id: userId }, 404);
      }

      return json({
        ok: true,
        profile: profileRow,
        period_days: days,
        summary: summaryRow || {},
        by_day: byDayRows.results || [],
        sessions: sessionRows.results || []
      });
    }

    // ===== 녹화(Recording) =====
    if (path === '/api/recordings/start' && method === 'POST') {
      const b = await request.json() as any;
      const now = Date.now();
      // 동의 안 한 학생 필터링
      const participantIds = (b.participant_ids || []) as string[];
      let consentedIds: string[] = [];
      if (participantIds.length > 0) {
        const placeholders = participantIds.map(() => '?').join(',');
        const rs = await env.DB.prepare(
          `SELECT user_id FROM consents WHERE user_id IN (${placeholders}) AND withdrawn_at IS NULL AND recording_consent = 1`
        ).bind(...participantIds).all<{ user_id: string }>();
        consentedIds = (rs.results || []).map(r => r.user_id);
      }
      const RETENTION_MS = 30 * 24 * 3600 * 1000; // 1개월
      const res = await env.DB.prepare(
        `INSERT INTO recordings (room_id, teacher_id, teacher_name, filename, participant_ids, participant_names, consented_user_ids, started_at, expires_at, storage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'local')`
      ).bind(
        b.room_id, b.teacher_id, b.teacher_name || null,
        b.filename || `rec_${b.room_id}_${now}.webm`,
        JSON.stringify(participantIds), JSON.stringify(b.participant_names || []),
        JSON.stringify(consentedIds), now, now + RETENTION_MS
      ).run();
      return json({
        ok: true,
        recording_id: res.meta.last_row_id,
        consented_count: consentedIds.length,
        total_participants: participantIds.length,
        non_consented: participantIds.filter(id => !consentedIds.includes(id))
      });
    }

    if (path === '/api/recordings/stop' && method === 'POST') {
      const b = await request.json() as any;
      const now = Date.now();
      await env.DB.prepare(
        `UPDATE recordings SET ended_at = ?, duration_ms = ?, size_bytes = ?, status = 'completed',
         file_url = COALESCE(?, file_url), storage = COALESCE(?, storage)
         WHERE id = ?`
      ).bind(now, b.duration_ms || 0, b.size_bytes || 0, b.file_url || null, b.storage || null, b.recording_id).run();
      return json({ ok: true, ended_at: now });
    }

    if (path === '/api/recordings' && method === 'GET') {
      // 녹화 목록 조회 — D1 의 recordings 메타데이터 + (참여도 점수) 함께 반환.
      // 참여도 점수는 attendance 테이블의 talk-time 비율로 도출한다.
      //   speaking_score : (총 활성 발화시간 / 총 세션시간) × 100
      //                    같은 room_id 이면서 해당 녹화 시간대(joined_at 이 녹화 window 내부)인
      //                    attendance 행만 평균. 시간대 필터가 없으면 과거 수업 데이터가
      //                    섞여 점수가 일정하게 나오므로 반드시 window 로 제한해야 함.
      //   gaze_score    : MediaPipe FaceLandmarker 로 계산된 "정면 응시 비율"(%).
      //                   public/js/mango-gaze.js → /api/gaze-score 경로로 attendance 에 누적.
      //                   speaking_score 와 동일 시간 window 로 평균.
      // 가중평균/총참여도(participation_score) 계산은 프런트(JS)에서 수행하여 점수 정의 변경 시 배포 없이 조정 가능하게 함.
      // --- 필터·페이지네이션 파라미터 (Phase 3) ----------------------
      const teacherId = url.searchParams.get('teacher_id');
      const roomId    = url.searchParams.get('room_id');
      const qSearch   = (url.searchParams.get('q') || '').trim();           // 방ID / 교사명 / 교사ID LIKE
      const dateFrom  = url.searchParams.get('date_from');                  // YYYY-MM-DD (KST 기준 00:00)
      const dateTo    = url.searchParams.get('date_to');                    // YYYY-MM-DD (KST 기준 23:59:59)
      const status    = url.searchParams.get('status');                     // ended | recording | aborted | deleted | all
      const limit     = Math.max(1,  Math.min(200, parseInt(url.searchParams.get('limit')  || '50', 10)));
      const offset    = Math.max(0,                parseInt(url.searchParams.get('offset') || '0',  10));

      // WHERE 조립 (count + list 공용)
      const whereParts: string[] = [];
      const whereBinds: any[]    = [];
      if (teacherId) { whereParts.push('r.teacher_id = ?'); whereBinds.push(teacherId); }
      if (roomId)    { whereParts.push('r.room_id = ?');    whereBinds.push(roomId); }
      if (qSearch) {
        whereParts.push("(r.room_id LIKE ? OR COALESCE(r.teacher_name,'') LIKE ? OR COALESCE(r.teacher_id,'') LIKE ?)");
        const p = `%${qSearch}%`;
        whereBinds.push(p, p, p);
      }
      if (dateFrom) {
        const ms = Date.parse(dateFrom + 'T00:00:00+09:00');
        if (!isNaN(ms)) { whereParts.push('r.started_at >= ?'); whereBinds.push(ms); }
      }
      if (dateTo) {
        const ms = Date.parse(dateTo + 'T23:59:59+09:00');
        if (!isNaN(ms)) { whereParts.push('r.started_at <= ?'); whereBinds.push(ms); }
      }
      if (status && status !== 'all') {
        whereParts.push('r.status = ?');
        whereBinds.push(status);
      }
      const whereSQL = whereParts.length ? ('WHERE ' + whereParts.join(' AND ')) : 'WHERE 1=1';

      // Total count (필터 적용된 상태에서의 전체 건수 — 페이지네이션 UI 에 사용)
      const countStmt = env.DB.prepare(`SELECT COUNT(*) AS total FROM recordings r ${whereSQL}`);
      const countRow  = whereBinds.length
        ? await countStmt.bind(...whereBinds).first<{ total: number }>()
        : await countStmt.first<{ total: number }>();
      const total = countRow?.total || 0;

      let q = `SELECT r.id, r.room_id, r.teacher_id, r.teacher_name, r.filename, r.file_url,
                      r.size_bytes, r.duration_ms,
                      r.participant_names, r.consented_user_ids,
                      r.started_at, r.ended_at, r.status, r.storage, r.expires_at,
                      /* 시선 점수 — 해당 녹화 시간대의 attendance.gaze_score 평균
                         window = [started_at - 30s, ended_at 또는 started_at + duration + 30s] */
                      (SELECT ROUND(AVG(a.gaze_score), 1)
                       FROM attendance a
                       WHERE a.room_id = r.room_id
                         AND a.gaze_score IS NOT NULL
                         AND a.joined_at >= (COALESCE(r.started_at, 0) - 30000)
                         AND a.joined_at <= (
                               COALESCE(
                                 r.ended_at,
                                 r.started_at + COALESCE(r.duration_ms, 0),
                                 r.started_at + 10800000
                               ) + 30000
                             )
                      ) AS gaze_score,
                      /* 말하기 점수 — 해당 녹화 시간대에 속한 attendance 행만 평균(0~100)
                         window = [started_at - 30s, ended_at 또는 started_at + duration + 30s]
                         ended_at 이 null 이면 started_at + duration_ms 로 대체,
                         duration 도 없으면 started_at + 3h (비정상 케이스) 로 제한 */
                      (SELECT ROUND(AVG(
                                CAST(a.total_active_ms AS REAL) * 100.0
                                / NULLIF(a.total_session_ms, 0)
                              ), 1)
                       FROM attendance a
                       WHERE a.room_id = r.room_id
                         AND a.total_session_ms > 0
                         AND a.joined_at >= (COALESCE(r.started_at, 0) - 30000)
                         AND a.joined_at <= (
                               COALESCE(
                                 r.ended_at,
                                 r.started_at + COALESCE(r.duration_ms, 0),
                                 r.started_at + 10800000
                               ) + 30000
                             )
                      ) AS speaking_score,
                      /* 진단 필드 (admin UI 툴팁용) — "왜 점수가 — 인가?" 를 사후 추적 */
                      (SELECT COUNT(1) FROM attendance a
                        WHERE a.room_id = r.room_id
                          AND a.joined_at >= (COALESCE(r.started_at, 0) - 30000)
                          AND a.joined_at <= (
                                COALESCE(r.ended_at,
                                         r.started_at + COALESCE(r.duration_ms, 0),
                                         r.started_at + 10800000) + 30000
                              )
                      ) AS attendance_count,
                      (SELECT COUNT(1) FROM attendance a
                        WHERE a.room_id = r.room_id
                          AND (a.gaze_samples = 0 OR a.gaze_samples IS NULL)
                          AND a.joined_at >= (COALESCE(r.started_at, 0) - 30000)
                          AND a.joined_at <= (
                                COALESCE(r.ended_at,
                                         r.started_at + COALESCE(r.duration_ms, 0),
                                         r.started_at + 10800000) + 30000
                              )
                      ) AS gaze_missing_count,
                      (SELECT COUNT(1) FROM attendance a
                        WHERE a.room_id = r.room_id
                          AND COALESCE(a.total_session_ms, 0) > 0
                          AND COALESCE(a.total_active_ms, 0) = 0
                          AND a.joined_at >= (COALESCE(r.started_at, 0) - 30000)
                          AND a.joined_at <= (
                                COALESCE(r.ended_at,
                                         r.started_at + COALESCE(r.duration_ms, 0),
                                         r.started_at + 10800000) + 30000
                              )
                      ) AS speaking_zero_count
               FROM recordings r ${whereSQL}
               ORDER BY r.started_at DESC LIMIT ? OFFSET ?`;
      const listBinds = [...whereBinds, limit, offset];
      const rs = await env.DB.prepare(q).bind(...listBinds).all();

      // 응답 본문은 배열 그대로 유지 (하위 호환성). 페이지네이션 메타는 헤더로 전달.
      return new Response(JSON.stringify(rs.results || []), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'X-Total-Count, X-Offset, X-Limit',
          'X-Total-Count': String(total),
          'X-Offset':      String(offset),
          'X-Limit':       String(limit),
          'Cache-Control': 'no-store'
        }
      });
    }

    if (path.startsWith('/api/recordings/') && method === 'DELETE') {
      const id = parseInt(path.replace('/api/recordings/', ''), 10);
      if (!id) return json({ ok: false, error: 'invalid_id' }, 400);
      await env.DB.prepare(`UPDATE recordings SET status = 'deleted' WHERE id = ?`).bind(id).run();
      return json({ ok: true });
    }

    // ===== 동의(Consent) =====
    if (path === '/api/consents' && method === 'POST') {
      const b = await parseJsonBody(request);
      if (!b || !b.user_id) return invalidBody(['user_id']);
      const now = Date.now();
      const ip = request.headers.get('cf-connecting-ip') || '';
      const ua = request.headers.get('user-agent') || '';
      const res = await env.DB.prepare(
        `INSERT INTO consents (user_id, username, role, consent_version,
           recording_consent, voice_analysis_consent, attendance_consent, reward_consent, kakao_consent,
           guardian_required, guardian_status, guardian_contact,
           ip_address, user_agent, consented_at, raw_payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        b.user_id, b.username || null, b.role || 'student', b.consent_version || 'v1.0',
        b.recording ? 1 : 0, b.voice_analysis ? 1 : 0, b.attendance ? 1 : 0, b.reward ? 1 : 0, b.kakao ? 1 : 0,
        b.guardian_required ? 1 : 0, b.guardian_status || (b.guardian_required ? 'pending' : 'not_required'), b.guardian_contact || null,
        ip, ua, now, JSON.stringify(b)
      ).run();
      return json({ ok: true, consent_id: res.meta.last_row_id, consented_at: now });
    }

    if (path.startsWith('/api/consents/') && method === 'GET') {
      const userId = decodeURIComponent(path.replace('/api/consents/', ''));
      const row = await env.DB.prepare(
        `SELECT * FROM consents WHERE user_id = ? AND withdrawn_at IS NULL
         ORDER BY consented_at DESC LIMIT 1`
      ).bind(userId).first();
      return json(row || null);
    }

    if (path === '/api/consents/withdraw' && method === 'POST') {
      const b = await request.json() as any;
      const now = Date.now();
      await env.DB.prepare(
        `UPDATE consents SET withdrawn_at = ? WHERE user_id = ? AND withdrawn_at IS NULL`
      ).bind(now, b.user_id).run();
      return json({ ok: true, withdrawn_at: now });
    }

    return null;
  } catch (err: any) {
    console.error('Mango API error:', err);
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
}
