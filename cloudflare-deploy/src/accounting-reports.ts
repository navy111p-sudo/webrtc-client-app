/**
 * accounting-reports.ts — 회계 리포트 6종
 *
 *   GET /api/admin/reports/monthly?period=YYYY-MM        월간 회계 리포트
 *   GET /api/admin/reports/quarterly?year=YYYY&q=N       분기 보고서 (N: 1-4)
 *   GET /api/admin/reports/annual?year=YYYY              연간 결산
 *   GET /api/admin/reports/franchise?period=YYYY-MM      가맹점별 정산서
 *   GET /api/admin/reports/payslips?period=YYYY-MM       강사별 급여명세서 (전체)
 *   GET /api/admin/reports/kpi?period=YYYY-MM            경영지표 (LTV·CAC·ROI·이익률)
 *
 *   format=json  (기본)  → JSON
 *   format=csv          → text/csv 다운로드
 *
 * 모든 쿼리는 student_payments / students_erp / attendance / payslips / teachers /
 * franchises / centers / enrollments 등 기존 테이블을 사용. 누락된 테이블이 있어도
 * try/catch 로 0 으로 graceful degradation (api-mango.ts 패턴 동일).
 */

interface Env {
  DB: D1Database;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

const csv = (filename: string, rows: (string | number)[][]): Response => {
  // CSV escape (RFC 4180)
  const esc = (v: string | number) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const body = '﻿' + rows.map(r => r.map(esc).join(',')).join('\n');
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
};

const err = (msg: string, status = 400) => json({ ok: false, error: msg }, status);

const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
  try { return await fn(); } catch { return fallback; }
};

// 월(YYYY-MM)을 KST 기준 startMs / endMs (Unix seconds) 로 변환
function monthRange(period: string): { startSec: number; endSec: number; label: string } {
  const [y, m] = period.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) throw new Error('invalid period (YYYY-MM)');
  const start = new Date(Date.UTC(y, m - 1, 1) - 9 * 3600 * 1000);
  const end = new Date(Date.UTC(y, m, 1) - 9 * 3600 * 1000);
  return {
    startSec: Math.floor(start.getTime() / 1000),
    endSec: Math.floor(end.getTime() / 1000),
    label: `${y}년 ${m}월`,
  };
}

function quarterRange(year: number, q: number) {
  const startMonth = (q - 1) * 3 + 1;
  const months = [0, 1, 2].map(i => `${year}-${String(startMonth + i).padStart(2, '0')}`);
  return { months, label: `${year}년 ${q}분기` };
}

// ────────────────────────────────────────────────────────────────────
// 메인 라우터
// ────────────────────────────────────────────────────────────────────
export async function reportsRouter(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const p = url.pathname.replace(/^\/api\/admin\/reports\//, '');
  const fmt = url.searchParams.get('format') || 'json';

  try {
    if (p === 'monthly')   return await monthlyReport(env, url, fmt);
    if (p === 'quarterly') return await quarterlyReport(env, url, fmt);
    if (p === 'annual')    return await annualReport(env, url, fmt);
    if (p === 'franchise') return await franchiseReport(env, url, fmt);
    if (p === 'payslips')  return await payslipsReport(env, url, fmt);
    if (p === 'kpi')       return await kpiReport(env, url, fmt);
    return err('not found: ' + p, 404);
  } catch (e: any) {
    return err(e?.message || 'internal error', 500);
  }
}

// ────────────────────────────────────────────────────────────────────
// 1) 월간 회계 리포트
// ────────────────────────────────────────────────────────────────────
async function monthlyReport(env: Env, url: URL, fmt: string): Promise<Response> {
  const period = url.searchParams.get('period') || currentMonth();
  const { startSec, endSec, label } = monthRange(period);

  // 매출 + 결제 건수
  const rev = await safe(async () => {
    const r = await env.DB.prepare(`
      SELECT
        COALESCE(SUM(amount_krw), 0) AS revenue,
        COUNT(*) AS pay_count,
        COUNT(DISTINCT user_id) AS paying_users
      FROM student_payments
      WHERE status='paid' AND paid_at >= ? AND paid_at < ?
    `).bind(startSec, endSec).first<{ revenue: number; pay_count: number; paying_users: number }>();
    return r || { revenue: 0, pay_count: 0, paying_users: 0 };
  }, { revenue: 0, pay_count: 0, paying_users: 0 });

  // 결제수단별 분포
  const byMethod = await safe(async () => {
    const r = await env.DB.prepare(`
      SELECT COALESCE(method,'기타') AS method,
             COUNT(*) AS cnt,
             COALESCE(SUM(amount_krw),0) AS total
      FROM student_payments
      WHERE status='paid' AND paid_at >= ? AND paid_at < ?
      GROUP BY method ORDER BY total DESC
    `).bind(startSec, endSec).all();
    return (r.results || []) as Array<{ method: string; cnt: number; total: number }>;
  }, []);

  // 신규 학생 / 만료 학생
  const stuMv = await safe(async () => {
    const yyyymm = period;
    const r = await env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM students_erp WHERE substr(COALESCE(signup_date,''),1,7) = ?) AS new_signups,
        (SELECT COUNT(*) FROM students_erp WHERE substr(COALESCE(end_date,''),1,7) = ?) AS expirations,
        (SELECT COUNT(*) FROM students_erp WHERE status='정상') AS active_total
    `).bind(yyyymm, yyyymm).first<{ new_signups: number; expirations: number; active_total: number }>();
    return r || { new_signups: 0, expirations: 0, active_total: 0 };
  }, { new_signups: 0, expirations: 0, active_total: 0 });

  // 강사 급여 합계 (Phase 8 payslips)
  const payroll = await safe(async () => {
    const r = await env.DB.prepare(`
      SELECT COALESCE(SUM(payment_krw),0) AS total,
             COUNT(*) AS teachers
      FROM payslips WHERE period = ?
    `).bind(period).first<{ total: number; teachers: number }>();
    return r || { total: 0, teachers: 0 };
  }, { total: 0, teachers: 0 });

  // 수업 시간 (분 단위 합계)
  const classMin = await safe(async () => {
    const r = await env.DB.prepare(`
      SELECT COALESCE(SUM(total_active_ms),0)/60000 AS total_min,
             COUNT(*) AS sessions
      FROM attendance
      WHERE date BETWEEN ? AND ?
    `).bind(period + '-01', period + '-31').first<{ total_min: number; sessions: number }>();
    return r || { total_min: 0, sessions: 0 };
  }, { total_min: 0, sessions: 0 });

  // 추정 비용
  const pgFee = Math.round(rev.revenue * 0.033);  // PG 수수료 약 3.3%
  const opCost = Math.round(rev.revenue * 0.10);  // 운영비 추정 10% (서버·인건비·임대료)
  const totalCost = payroll.total + pgFee + opCost;
  const netIncome = rev.revenue - totalCost;
  const margin = rev.revenue > 0 ? (netIncome / rev.revenue) * 100 : 0;

  const data = {
    ok: true,
    type: 'monthly',
    period, label,
    summary: {
      revenue: rev.revenue,
      pay_count: rev.pay_count,
      paying_users: rev.paying_users,
      avg_per_user: rev.paying_users > 0 ? Math.round(rev.revenue / rev.paying_users) : 0,
      new_signups: stuMv.new_signups,
      expirations: stuMv.expirations,
      active_students: stuMv.active_total,
      class_minutes: classMin.total_min,
      class_sessions: classMin.sessions,
    },
    cost: {
      teacher_payroll: payroll.total,
      teacher_count: payroll.teachers,
      pg_fee: pgFee,
      op_cost: opCost,
      total: totalCost,
    },
    pl: {
      revenue: rev.revenue,
      cost: totalCost,
      net_income: netIncome,
      margin_pct: Number(margin.toFixed(2)),
    },
    by_method: byMethod,
  };

  if (fmt === 'csv') {
    return csv(`monthly-${period}.csv`, [
      ['망고아이 월간 회계 리포트', label],
      [],
      ['매출 합계', rev.revenue],
      ['결제 건수', rev.pay_count],
      ['결제 학생수', rev.paying_users],
      ['평균 결제액', data.summary.avg_per_user],
      ['신규 가입', stuMv.new_signups],
      ['만료', stuMv.expirations],
      ['활성 학생수', stuMv.active_total],
      ['수업 분', classMin.total_min],
      ['세션 수', classMin.sessions],
      [],
      ['[비용]'],
      ['강사 급여', payroll.total],
      ['PG 수수료(추정 3.3%)', pgFee],
      ['운영비(추정 10%)', opCost],
      ['비용 합계', totalCost],
      [],
      ['[손익]'],
      ['매출', rev.revenue],
      ['비용', totalCost],
      ['순이익', netIncome],
      ['이익률(%)', data.pl.margin_pct],
      [],
      ['[결제수단별]'],
      ['수단', '건수', '금액'],
      ...byMethod.map(m => [m.method, m.cnt, m.total]),
    ]);
  }
  return json(data);
}

// ────────────────────────────────────────────────────────────────────
// 2) 분기 보고서 — 3개월 트렌드
// ────────────────────────────────────────────────────────────────────
async function quarterlyReport(env: Env, url: URL, fmt: string): Promise<Response> {
  const year = Number(url.searchParams.get('year')) || new Date().getUTCFullYear();
  const q = Number(url.searchParams.get('q')) || 1;
  if (q < 1 || q > 4) return err('q must be 1-4');
  const { months, label } = quarterRange(year, q);

  const monthlies = await Promise.all(months.map(async (period) => {
    const { startSec, endSec } = monthRange(period);
    const r = await safe(async () => {
      const x = await env.DB.prepare(`
        SELECT COALESCE(SUM(amount_krw),0) AS revenue, COUNT(*) AS pays
        FROM student_payments WHERE status='paid' AND paid_at>=? AND paid_at<?
      `).bind(startSec, endSec).first<{ revenue: number; pays: number }>();
      return x || { revenue: 0, pays: 0 };
    }, { revenue: 0, pays: 0 });
    const payroll = await safe(async () => {
      const x = await env.DB.prepare(`SELECT COALESCE(SUM(payment_krw),0) AS p FROM payslips WHERE period=?`)
        .bind(period).first<{ p: number }>();
      return x?.p || 0;
    }, 0);
    const cost = payroll + Math.round(r.revenue * 0.133); // PG 3.3% + 운영 10%
    return { period, revenue: r.revenue, pays: r.pays, payroll, cost, net: r.revenue - cost };
  }));

  const totals = monthlies.reduce((a, m) => ({
    revenue: a.revenue + m.revenue,
    pays: a.pays + m.pays,
    payroll: a.payroll + m.payroll,
    cost: a.cost + m.cost,
    net: a.net + m.net,
  }), { revenue: 0, pays: 0, payroll: 0, cost: 0, net: 0 });

  const data = { ok: true, type: 'quarterly', year, quarter: q, label, monthlies, totals,
    margin_pct: totals.revenue > 0 ? Number(((totals.net / totals.revenue) * 100).toFixed(2)) : 0,
  };

  if (fmt === 'csv') {
    return csv(`quarterly-${year}-Q${q}.csv`, [
      ['망고아이 분기 보고서', label],
      [],
      ['월', '매출', '결제건수', '강사급여', '비용 합계', '순이익'],
      ...monthlies.map(m => [m.period, m.revenue, m.pays, m.payroll, m.cost, m.net]),
      ['합계', totals.revenue, totals.pays, totals.payroll, totals.cost, totals.net],
    ]);
  }
  return json(data);
}

// ────────────────────────────────────────────────────────────────────
// 3) 연간 결산
// ────────────────────────────────────────────────────────────────────
async function annualReport(env: Env, url: URL, fmt: string): Promise<Response> {
  const year = Number(url.searchParams.get('year')) || new Date().getUTCFullYear();
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);

  const monthlies = await Promise.all(months.map(async (period) => {
    const { startSec, endSec } = monthRange(period);
    const r = await safe(async () => {
      const x = await env.DB.prepare(`
        SELECT COALESCE(SUM(amount_krw),0) AS revenue, COUNT(*) AS pays
        FROM student_payments WHERE status='paid' AND paid_at>=? AND paid_at<?
      `).bind(startSec, endSec).first<{ revenue: number; pays: number }>();
      return x || { revenue: 0, pays: 0 };
    }, { revenue: 0, pays: 0 });
    const payroll = await safe(async () => {
      const x = await env.DB.prepare(`SELECT COALESCE(SUM(payment_krw),0) AS p FROM payslips WHERE period=?`)
        .bind(period).first<{ p: number }>();
      return x?.p || 0;
    }, 0);
    const cost = payroll + Math.round(r.revenue * 0.133);
    return { period, revenue: r.revenue, pays: r.pays, payroll, cost, net: r.revenue - cost };
  }));

  const totals = monthlies.reduce((a, m) => ({
    revenue: a.revenue + m.revenue, pays: a.pays + m.pays,
    payroll: a.payroll + m.payroll, cost: a.cost + m.cost, net: a.net + m.net,
  }), { revenue: 0, pays: 0, payroll: 0, cost: 0, net: 0 });

  const data = {
    ok: true, type: 'annual', year, label: `${year}년 결산`,
    monthlies, totals,
    margin_pct: totals.revenue > 0 ? Number(((totals.net / totals.revenue) * 100).toFixed(2)) : 0,
  };

  if (fmt === 'csv') {
    return csv(`annual-${year}.csv`, [
      ['망고아이 연간 결산', `${year}년`],
      [],
      ['월', '매출', '결제건수', '강사급여', '비용 합계', '순이익'],
      ...monthlies.map(m => [m.period, m.revenue, m.pays, m.payroll, m.cost, m.net]),
      ['합계', totals.revenue, totals.pays, totals.payroll, totals.cost, totals.net],
    ]);
  }
  return json(data);
}

// ────────────────────────────────────────────────────────────────────
// 4) 가맹점별 정산서
// ────────────────────────────────────────────────────────────────────
async function franchiseReport(env: Env, url: URL, fmt: string): Promise<Response> {
  const period = url.searchParams.get('period') || currentMonth();
  const { startSec, endSec, label } = monthRange(period);
  const hqFeeRate = Number(url.searchParams.get('hq_fee')) || 0.15; // 본사 수수료 15%

  // 가맹점 목록
  const franchises = await safe(async () => {
    const r = await env.DB.prepare(`SELECT id, name FROM franchises WHERE active=1 ORDER BY name`).all();
    return (r.results || []) as Array<{ id: number; name: string }>;
  }, []);

  // 가맹점별 매출 — students_erp 에 franchise_id 가 있다면 좋지만 없을 수 있음
  // → 대신 가맹점별 결제 분배가 안되어 있으면 전체 매출로 대체
  const totalRev = await safe(async () => {
    const r = await env.DB.prepare(`
      SELECT COALESCE(SUM(amount_krw),0) AS revenue
      FROM student_payments WHERE status='paid' AND paid_at>=? AND paid_at<?
    `).bind(startSec, endSec).first<{ revenue: number }>();
    return r?.revenue || 0;
  }, 0);

  // 가맹점이 없으면 본사 단독으로 표시
  const rows = franchises.length > 0
    ? franchises.map((f, i) => {
        // 균등 분배 추정 (실제 환경에선 students_erp.franchise_id 로 정확 계산)
        const share = Math.round(totalRev / franchises.length);
        const fee = Math.round(share * hqFeeRate);
        return {
          franchise_id: f.id,
          franchise_name: f.name,
          gross_revenue: share,
          hq_fee: fee,
          net_settlement: share - fee,
          due_date: nextSettlementDate(period),
          status: 'pending',
        };
      })
    : [{
        franchise_id: 0, franchise_name: '본사 직영',
        gross_revenue: totalRev,
        hq_fee: 0,
        net_settlement: totalRev,
        due_date: nextSettlementDate(period),
        status: 'self',
      }];

  const totals = rows.reduce((a, r) => ({
    gross: a.gross + r.gross_revenue,
    fee: a.fee + r.hq_fee,
    net: a.net + r.net_settlement,
  }), { gross: 0, fee: 0, net: 0 });

  const data = { ok: true, type: 'franchise', period, label, hq_fee_rate: hqFeeRate, rows, totals };

  if (fmt === 'csv') {
    return csv(`franchise-settlement-${period}.csv`, [
      ['망고아이 가맹점 정산서', label],
      [`본사 수수료율: ${(hqFeeRate * 100).toFixed(1)}%`],
      [],
      ['가맹점', '총 매출', '본사 수수료', '정산액', '송금예정일', '상태'],
      ...rows.map(r => [r.franchise_name, r.gross_revenue, r.hq_fee, r.net_settlement, r.due_date, r.status]),
      ['합계', totals.gross, totals.fee, totals.net, '', ''],
    ]);
  }
  return json(data);
}

// ────────────────────────────────────────────────────────────────────
// 5) 강사별 급여명세서
// ────────────────────────────────────────────────────────────────────
async function payslipsReport(env: Env, url: URL, fmt: string): Promise<Response> {
  const period = url.searchParams.get('period') || currentMonth();

  const rows = await safe(async () => {
    const r = await env.DB.prepare(`
      SELECT p.teacher_id, p.period,
             COALESCE(t.name, p.teacher_id) AS teacher_name,
             COALESCE(t.country,'') AS country,
             COALESCE(p.minutes_taught, 0) AS minutes,
             COALESCE(p.payment_php, 0) AS payment_php,
             COALESCE(p.payment_krw, 0) AS payment_krw,
             COALESCE(p.evaluation_score, 0) AS eval_score,
             COALESCE(p.bonus_krw, 0) AS bonus,
             COALESCE(p.deduction_krw, 0) AS deduction,
             COALESCE(p.payment_krw,0) + COALESCE(p.bonus_krw,0) - COALESCE(p.deduction_krw,0) AS net
      FROM payslips p
      LEFT JOIN teachers t ON t.id = p.teacher_id
      WHERE p.period = ?
      ORDER BY net DESC
    `).bind(period).all();
    return (r.results || []) as Array<any>;
  }, []);

  const totals = rows.reduce((a, r) => ({
    minutes: a.minutes + (r.minutes || 0),
    payment: a.payment + (r.payment_krw || 0),
    bonus: a.bonus + (r.bonus || 0),
    deduction: a.deduction + (r.deduction || 0),
    net: a.net + (r.net || 0),
  }), { minutes: 0, payment: 0, bonus: 0, deduction: 0, net: 0 });

  const data = { ok: true, type: 'payslips', period, label: `${period} 강사 급여명세서`,
    rows, totals, teacher_count: rows.length };

  if (fmt === 'csv') {
    return csv(`payslips-${period}.csv`, [
      ['망고아이 강사 급여명세서', period],
      [],
      ['강사ID', '이름', '국가', '수업분', '기본급여(KRW)', '상여', '공제', '실지급'],
      ...rows.map((r: any) => [
        r.teacher_id, r.teacher_name, r.country,
        r.minutes, r.payment_krw, r.bonus, r.deduction, r.net
      ]),
      ['합계', '', '', totals.minutes, totals.payment, totals.bonus, totals.deduction, totals.net],
    ]);
  }
  return json(data);
}

// ────────────────────────────────────────────────────────────────────
// 6) 경영지표 (KPI)
// ────────────────────────────────────────────────────────────────────
async function kpiReport(env: Env, url: URL, fmt: string): Promise<Response> {
  const period = url.searchParams.get('period') || currentMonth();
  const { startSec, endSec, label } = monthRange(period);

  // 매출
  const rev = await safe(async () => {
    const r = await env.DB.prepare(`
      SELECT COALESCE(SUM(amount_krw),0) AS revenue,
             COUNT(DISTINCT user_id) AS paying_users
      FROM student_payments WHERE status='paid' AND paid_at>=? AND paid_at<?
    `).bind(startSec, endSec).first<{ revenue: number; paying_users: number }>();
    return r || { revenue: 0, paying_users: 0 };
  }, { revenue: 0, paying_users: 0 });

  // 활성 학생
  const active = await safe(async () => {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS c FROM students_erp WHERE status='정상'`).first<{ c: number }>();
    return r?.c || 0;
  }, 0);

  // 신규 학생
  const newSignups = await safe(async () => {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS c FROM students_erp WHERE substr(COALESCE(signup_date,''),1,7)=?`)
      .bind(period).first<{ c: number }>();
    return r?.c || 0;
  }, 0);

  // 평균 누적 결제액 (LTV proxy) — 학생당 지금까지 결제 합계의 평균
  const ltvProxy = await safe(async () => {
    const r = await env.DB.prepare(`
      SELECT AVG(total) AS avg_total FROM (
        SELECT user_id, SUM(amount_krw) AS total
        FROM student_payments WHERE status='paid' GROUP BY user_id
      )
    `).first<{ avg_total: number }>();
    return Math.round(r?.avg_total || 0);
  }, 0);

  // 강사 급여
  const payroll = await safe(async () => {
    const r = await env.DB.prepare(`SELECT COALESCE(SUM(payment_krw),0) AS p FROM payslips WHERE period=?`)
      .bind(period).first<{ p: number }>();
    return r?.p || 0;
  }, 0);

  // 결제 성공률 (paid / 전체)
  const successRate = await safe(async () => {
    const r = await env.DB.prepare(`
      SELECT
        SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) AS ok_cnt,
        COUNT(*) AS all_cnt
      FROM student_payments WHERE paid_at>=? AND paid_at<?
    `).bind(startSec, endSec).first<{ ok_cnt: number; all_cnt: number }>();
    if (!r || !r.all_cnt) return 0;
    return Number(((r.ok_cnt / r.all_cnt) * 100).toFixed(1));
  }, 0);

  // 수업 시간 / 학생
  const classMin = await safe(async () => {
    const r = await env.DB.prepare(`
      SELECT COALESCE(SUM(total_active_ms),0)/60000 AS total_min,
             COUNT(DISTINCT user_id) AS uniq
      FROM attendance WHERE date BETWEEN ? AND ?
    `).bind(period + '-01', period + '-31').first<{ total_min: number; uniq: number }>();
    return r || { total_min: 0, uniq: 0 };
  }, { total_min: 0, uniq: 0 });

  const arpu = active > 0 ? Math.round(rev.revenue / active) : 0;
  const cost = payroll + Math.round(rev.revenue * 0.133);
  const net = rev.revenue - cost;
  const margin = rev.revenue > 0 ? (net / rev.revenue) * 100 : 0;
  const roi = cost > 0 ? (net / cost) * 100 : 0;
  // CAC: 마케팅비를 알 수 없으므로 순이익의 30% 추정
  const cacEst = Math.round((rev.revenue * 0.05) / Math.max(newSignups, 1));

  const kpis = [
    { key: 'revenue',         label: '월 매출',                 value: rev.revenue,      unit: 'KRW' },
    { key: 'active_students', label: '활성 학생',               value: active,           unit: '명' },
    { key: 'paying_users',    label: '결제 학생',               value: rev.paying_users, unit: '명' },
    { key: 'new_signups',     label: '신규 가입',               value: newSignups,       unit: '명' },
    { key: 'arpu',            label: 'ARPU (학생 1인 평균 매출)', value: arpu,             unit: 'KRW' },
    { key: 'ltv',             label: 'LTV (평균 누적결제)',     value: ltvProxy,         unit: 'KRW' },
    { key: 'cac_est',         label: 'CAC 추정 (마케팅비÷신규)', value: cacEst,           unit: 'KRW' },
    { key: 'ltv_cac',         label: 'LTV/CAC',                value: cacEst > 0 ? Number((ltvProxy / cacEst).toFixed(2)) : 0, unit: '배' },
    { key: 'margin_pct',      label: '이익률',                  value: Number(margin.toFixed(2)), unit: '%' },
    { key: 'roi_pct',         label: 'ROI',                    value: Number(roi.toFixed(2)),    unit: '%' },
    { key: 'success_rate',    label: '결제 성공률',             value: successRate,      unit: '%' },
    { key: 'class_min',       label: '총 수업 시간',            value: classMin.total_min, unit: '분' },
  ];

  const data = { ok: true, type: 'kpi', period, label: `${label} 경영지표 (KPI)`, kpis,
    revenue: rev.revenue, cost, net, payroll };

  if (fmt === 'csv') {
    return csv(`kpi-${period}.csv`, [
      ['망고아이 경영지표 (KPI)', label],
      [],
      ['지표', '값', '단위'],
      ...kpis.map(k => [k.label, k.value, k.unit]),
    ]);
  }
  return json(data);
}

// ────────────────────────────────────────────────────────────────────
// utils
// ────────────────────────────────────────────────────────────────────
function currentMonth(): string {
  const d = new Date(Date.now() + 9 * 3600 * 1000); // KST
  return d.toISOString().slice(0, 7);
}

function nextSettlementDate(period: string): string {
  // 매월 15일 송금 가정
  const [y, m] = period.split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 15));
  return next.toISOString().slice(0, 10);
}
