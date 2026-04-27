/**
 * ai-command.ts — 🥭 Phase 21 망고아이 AI 명령 오케스트레이터
 *
 * 사용자가 admin 통합검색창에 자연어로 입력하면 4단계 의도로 분류:
 *   1) answer    — 단순 Q&A (지식 기반 답변)
 *   2) navigate  — 페이지 이동 / 메뉴 라우팅
 *   3) query     — 백엔드 데이터 조회 (서버에서 자동 실행 → 결과 반환)
 *   4) action    — 실제 작업 (확인 다이얼로그 후 별도 엔드포인트로 실행)
 *
 * 모델: Cloudflare Workers AI — Llama 3.3 70B Instruct fp8-fast
 *   - 무료 일일 한도 (10k Neurons) 안에서 동작
 *   - JSON 모드로 구조화 응답 강제
 *   - 추후 Anthropic Claude 등으로 교체 시 callLLM() 함수 한 곳만 수정
 */

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

// ──────────────────────────────────────────────────────────
// 시스템 프롬프트 — 망고아이 AI 가 알아야 할 컨텍스트와 응답 스키마
// ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `당신은 망고아이(Mangoi) — 영어 화상수업 교육 플랫폼의 관리자 AI 비서입니다.
관리자가 통합검색창에 자연어로 입력하면 의도를 분류해서 JSON 으로만 응답하세요.

# 망고아이 시스템 개요
- 학생/강사 화상영어 수업, 출석·발화시간·시선점수 자동 기록
- 평가서, 발음연습, 보상(스티커/쿠폰), 결제, 가맹점/센터 ERP 운영
- D1 데이터베이스에 students_erp, attendance, student_payments, evaluations, recordings 등 보관

# 응답 규칙 (반드시 JSON 만 출력, 추가 텍스트 금지)
4가지 intent 중 하나로 분류:

1) "answer" — 일반 지식·시스템 사용법·간단 설명
   { "intent":"answer", "answer":"한국어 답변 (200자 이내)" }

2) "navigate" — 페이지 이동이 적절할 때
   사용 가능 경로:
   - "/admin.html" (메인 대시보드)
   - "/admin/students.html" (학생관리)
   - "/admin/student.html?uid=USER_ID" (학생 드릴다운)
   - "/admin/health.html" (시스템 상태)
   - "/admin/mypage.html" (관리자 마이페이지)
   { "intent":"navigate", "url":"/admin/students.html", "answer":"학생관리 페이지로 이동합니다." }

3) "query" — DB 데이터 조회. 다음 도구 중 하나 선택:
   - "today_stats"        : 오늘 매출·학생수·결석률·신규등록
   - "weekly_dashboard"   : 최근 7일 출석·발화·재연결률
   - "find_student"       : 학생 이름·UID 검색 (args.q)
   - "revenue"            : 매출 통계 (args.period: day|month|year)
   - "active_rooms"       : 현재 활성 화상수업 방
   - "recent_recordings"  : 최근 녹화 (args.limit, default 10)
   { "intent":"query", "tool":"today_stats", "args":{}, "answer":"오늘 지표를 조회합니다." }

4) "action" — 실제 작업 (확인 후 실행). 다음 액션만 허용:
   - "send_kakao_self"    : 관리자 본인 카톡 메모챗으로 메시지 (args.text)
   - "issue_sticker"      : 학생에게 스티커 발급 (args.user_id, args.reason)
   - "mark_intervention"  : 학생 개입 액션 기록 (args.user_id, args.note)
   { "intent":"action", "name":"send_kakao_self", "args":{"text":"..."}, "confirm_text":"카톡 메모챗으로 '...' 보낼까요?", "answer":"확인을 눌러주세요." }

# 분류 기준
- "오늘 매출 어때?" → query (today_stats)
- "김민수 학생 정보" → query (find_student, q="김민수")
- "학생관리 페이지 열어줘" → navigate
- "지금 수업 중인 방 있어?" → query (active_rooms)
- "내 카톡으로 오늘 결석 학생 보내줘" → action (send_kakao_self) — 단, 결석 학생을 모르므로 먼저 query 후 action 분리
- "발음연습이 뭐야?" → answer
- 분류 애매 / 불충분 → answer 로 명료화 질문

# 출력은 반드시 단일 JSON 객체. 코드블록·주석·여러 객체 금지.`;

// ──────────────────────────────────────────────────────────
// LLM 호출 — Workers AI Llama 3.3 70B
// ──────────────────────────────────────────────────────────
async function callLLM(env: { AI?: any }, command: string): Promise<any> {
  if (!env.AI) {
    throw new Error('AI binding not configured (wrangler.toml [ai] missing)');
  }

  // Workers AI JSON 모드 — response_format 으로 JSON 강제
  const result = await env.AI.run(MODEL, {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: command }
    ],
    max_tokens: 512,
    temperature: 0.3, // 의도 분류는 결정적이 좋음
    response_format: { type: 'json_object' }
  });

  // Workers AI 응답: { response: "..." } or { response: "..." } 형태
  const raw = (result?.response || result?.result?.response || '').trim();
  if (!raw) throw new Error('empty AI response');

  // JSON 파싱 — 코드블록이 섞여있을 수 있으니 안전하게
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 코드블록 ```json ... ``` 안에 들어있는 경우 추출 시도
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('AI response not JSON: ' + raw.slice(0, 200));
    parsed = JSON.parse(m[0]);
  }
  return parsed;
}

// ──────────────────────────────────────────────────────────
// 도구 디스패처 — query intent 의 tool 을 서버에서 실행
// ──────────────────────────────────────────────────────────
async function runTool(
  env: { DB: D1Database },
  tool: string,
  args: any
): Promise<any> {
  const todayKst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

  // 안전 헬퍼 — 개별 쿼리 실패가 전체 도구를 죽이지 않도록
  const safe = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch { return fallback; }
  };

  switch (tool) {
    case 'today_stats': {
      const startMs = new Date(todayKst + 'T00:00:00+09:00').getTime();
      const endMs = startMs + 86400000;
      const [rev, att, act, sign] = await Promise.all([
        safe(() => env.DB.prepare(`SELECT COALESCE(SUM(amount_krw),0) AS revenue, COUNT(*) AS cnt
                        FROM student_payments
                        WHERE status='paid' AND paid_at IS NOT NULL AND paid_at >= ? AND paid_at < ?`)
          .bind(startMs, endMs).first<any>(), { revenue: 0, cnt: 0 } as any),
        safe(() => env.DB.prepare(`SELECT COUNT(DISTINCT user_id) AS attended
                        FROM attendance WHERE date = ?`).bind(todayKst).first<any>(),
          { attended: 0 } as any),
        safe(() => env.DB.prepare(`SELECT COUNT(*) AS active
                        FROM students_erp
                        WHERE end_date IS NULL OR end_date='' OR end_date >= ?`)
          .bind(todayKst).first<any>(), { active: 0 } as any),
        safe(() => env.DB.prepare(`SELECT COUNT(*) AS signups FROM students_erp WHERE signup_date = ?`)
          .bind(todayKst).first<any>(), { signups: 0 } as any)
      ]);
      const attended = att?.attended || 0;
      const active = act?.active || 0;
      const absent = Math.max(0, active - attended);
      const rate = active > 0 ? Math.round((absent * 1000) / active) / 10 : 0;
      return {
        date: todayKst,
        revenue_krw: rev?.revenue || 0,
        pay_count: rev?.cnt || 0,
        attended,
        active_students: active,
        absence_rate_pct: rate,
        new_signups: sign?.signups || 0
      };
    }

    case 'weekly_dashboard': {
      const since = Date.now() - 7 * 86400000;
      const total = await env.DB.prepare(
        `SELECT COUNT(*) AS sessions, SUM(disconnect_count) AS disconnects,
                AVG(CASE WHEN total_session_ms>0 THEN total_active_ms*100.0/total_session_ms ELSE 0 END) AS active_pct
         FROM attendance WHERE joined_at >= ?`
      ).bind(since).first<any>();
      return {
        period: 'last_7_days',
        total_sessions: total?.sessions || 0,
        total_disconnects: total?.disconnects || 0,
        avg_speaking_pct: Math.round((total?.active_pct || 0) * 10) / 10
      };
    }

    case 'find_student': {
      const q = (args?.q || '').toString().trim();
      if (!q) return { error: 'query required' };
      const rows = await env.DB.prepare(
        `SELECT user_id, korean_name, english_name, status, signup_date, end_date
         FROM students_erp
         WHERE korean_name LIKE ? OR english_name LIKE ? OR user_id LIKE ?
         ORDER BY signup_date DESC LIMIT 10`
      ).bind('%' + q + '%', '%' + q + '%', '%' + q + '%').all<any>();
      return { matches: rows.results || [], count: (rows.results || []).length };
    }

    case 'revenue': {
      const period = (args?.period || 'month').toString();
      const kstDate = `date((paid_at + 32400000)/1000, 'unixepoch')`;
      let groupExpr = `substr(${kstDate},1,7)`;
      if (period === 'day') groupExpr = kstDate;
      else if (period === 'year') groupExpr = `substr(${kstDate},1,4)`;
      const rows = await env.DB.prepare(
        `SELECT ${groupExpr} AS label, SUM(amount_krw) AS revenue
         FROM student_payments WHERE status='paid' AND paid_at IS NOT NULL
         GROUP BY ${groupExpr} ORDER BY label DESC LIMIT 12`
      ).all<any>();
      return { period, items: rows.results || [] };
    }

    case 'active_rooms': {
      const rows = await env.DB.prepare(
        `SELECT room_id, COUNT(DISTINCT user_id) AS users, MIN(joined_at) AS started_at
         FROM attendance WHERE left_at IS NULL OR left_at = 0
         GROUP BY room_id ORDER BY started_at DESC LIMIT 20`
      ).all<any>();
      return { rooms: rows.results || [], count: (rows.results || []).length };
    }

    case 'recent_recordings': {
      const limit = Math.min(parseInt(args?.limit, 10) || 10, 30);
      const rows = await env.DB.prepare(
        `SELECT id, room_id, user_id, started_at, duration_ms, size_bytes
         FROM recordings ORDER BY started_at DESC LIMIT ?`
      ).bind(limit).all<any>();
      return { recordings: rows.results || [], count: (rows.results || []).length };
    }

    default:
      return { error: 'unknown_tool', tool };
  }
}

// ──────────────────────────────────────────────────────────
// 외부 진입점 — POST /api/admin/ai-command 핸들러가 호출
// ──────────────────────────────────────────────────────────
export async function processAiCommand(
  env: { AI?: any; DB: D1Database },
  command: string
): Promise<any> {
  const cmd = (command || '').toString().trim();
  if (!cmd) return { ok: false, error: 'empty_command' };
  if (cmd.length > 500) return { ok: false, error: 'command_too_long' };

  let aiResponse: any;
  try {
    aiResponse = await callLLM(env, cmd);
  } catch (e: any) {
    return { ok: false, error: 'ai_call_failed', detail: String(e?.message || e) };
  }

  const intent = aiResponse?.intent;

  // Level 1 — answer
  if (intent === 'answer') {
    return {
      ok: true,
      intent: 'answer',
      answer: aiResponse.answer || '(빈 응답)'
    };
  }

  // Level 2 — navigate
  if (intent === 'navigate') {
    return {
      ok: true,
      intent: 'navigate',
      url: aiResponse.url || '/admin.html',
      answer: aiResponse.answer || '페이지로 이동합니다.'
    };
  }

  // Level 3 — query (서버에서 도구 실행 후 결과 반환)
  if (intent === 'query') {
    const toolName = aiResponse.tool;
    const toolArgs = aiResponse.args || {};
    let toolResult: any = null;
    try {
      toolResult = await runTool(env, toolName, toolArgs);
    } catch (e: any) {
      return {
        ok: false,
        intent: 'query',
        error: 'tool_failed',
        tool: toolName,
        detail: String(e?.message || e)
      };
    }
    return {
      ok: true,
      intent: 'query',
      tool: toolName,
      args: toolArgs,
      result: toolResult,
      answer: aiResponse.answer || ''
    };
  }

  // Level 4 — action (실행은 별도 confirm 엔드포인트에서)
  if (intent === 'action') {
    const allowedActions = new Set(['send_kakao_self', 'issue_sticker', 'mark_intervention']);
    if (!allowedActions.has(aiResponse.name)) {
      return {
        ok: false,
        intent: 'action',
        error: 'action_not_allowed',
        name: aiResponse.name
      };
    }
    return {
      ok: true,
      intent: 'action',
      name: aiResponse.name,
      args: aiResponse.args || {},
      confirm_text: aiResponse.confirm_text || '실행할까요?',
      answer: aiResponse.answer || '확인이 필요합니다.'
    };
  }

  // unknown intent — fallback to answer
  return {
    ok: true,
    intent: 'answer',
    answer: aiResponse.answer || '명령을 이해하지 못했습니다. 다시 말씀해 주세요.'
  };
}

// ──────────────────────────────────────────────────────────
// Action 실행기 — POST /api/admin/ai-action 에서 호출
// (사용자가 confirm 한 후에만 들어옴)
// ──────────────────────────────────────────────────────────
export async function executeAction(
  env: { DB: D1Database; SESSION_STATE: KVNamespace },
  name: string,
  args: any,
  adminUserId: string | null
): Promise<any> {
  const allowed = new Set(['send_kakao_self', 'issue_sticker', 'mark_intervention']);
  if (!allowed.has(name)) {
    return { ok: false, error: 'action_not_allowed', name };
  }

  const auditId = 'aiact_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  try {
    if (name === 'send_kakao_self') {
      // 카톡 메모챗 발송은 외부 PS1/MCP 영역이라 여기서는 KV 큐에 기록만
      // (실제 발송은 클라이언트 측 KakaoTalk MCP 또는 별도 워커가 픽업)
      const text = String(args?.text || '').slice(0, 1000);
      if (!text) return { ok: false, error: 'empty_text' };
      const queueKey = `kakao_queue:${auditId}`;
      await env.SESSION_STATE.put(
        queueKey,
        JSON.stringify({ text, queued_at: Date.now(), by: adminUserId || 'unknown' }),
        { expirationTtl: 86400 }
      );
      return { ok: true, action: name, queued_id: auditId, text };
    }

    if (name === 'issue_sticker') {
      const userId = String(args?.user_id || '').trim();
      const reason = String(args?.reason || 'AI 명령으로 발급').slice(0, 200);
      if (!userId) return { ok: false, error: 'user_id_required' };
      await env.DB.prepare(
        `INSERT INTO rewards (user_id, type, reason, issued_at) VALUES (?, 'sticker', ?, ?)`
      ).bind(userId, reason, Date.now()).run();
      return { ok: true, action: name, user_id: userId, reason };
    }

    if (name === 'mark_intervention') {
      const userId = String(args?.user_id || '').trim();
      const note = String(args?.note || '').slice(0, 500);
      if (!userId) return { ok: false, error: 'user_id_required' };
      // intervention_logs 테이블 자동 생성 (스키마 누락 환경 대비)
      await env.DB.exec(
        `CREATE TABLE IF NOT EXISTS intervention_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          note TEXT,
          source TEXT,
          created_by TEXT,
          created_at INTEGER NOT NULL
        )`
      );
      await env.DB.prepare(
        `INSERT INTO intervention_logs (user_id, note, source, created_by, created_at)
         VALUES (?, ?, 'ai-command', ?, ?)`
      ).bind(userId, note, adminUserId || 'unknown', Date.now()).run();
      return { ok: true, action: name, user_id: userId, note };
    }

    return { ok: false, error: 'unhandled_action', name };
  } catch (e: any) {
    return { ok: false, error: 'action_exec_failed', detail: String(e?.message || e) };
  }
}
