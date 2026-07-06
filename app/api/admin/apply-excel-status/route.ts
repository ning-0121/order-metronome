// ============================================================
// GET /api/admin/apply-excel-status         → 预演(只报告不改)
// GET /api/admin/apply-excel-status?confirm=APPLY → 真应用 + 报告
// admin-only。据 生产订单一览(1).xlsx 一次性把老单里程碑设成对应阶段(生产中心据里程碑派生)。
// 用 service-role,可靠;返回 HTML 报告。一次性用,用完即弃。
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
const esc = (s: any) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
const DONE = ['done', 'completed', '已完成'];

// 阶段目标(据 Excel);key=目标,value=该阶段要 done 的里程碑 step_key(累计)。shipped=全 done+completed。
const UP_PROC = ['po_confirmed', 'mo_released', 'pre_prod_meeting', 'procurement_order_placed'];
const UP_KICK = [...UP_PROC, 'pre_production_sample_approved', 'production_kickoff'];
const UP_QC = [...UP_KICK, 'final_qc_check', 'factory_completion'];

const ORDERS: Record<string, { keys: string[] | 'ALL'; complete?: boolean; nos: string[] }> = {
  '已出货→完成': { keys: 'ALL', complete: true, nos: ['QM-20260414-003','QM-20260403-023','QM-20260406-006','QM-20260403-015','QM-20260403-028','QM-20260403-033','QM-20260518-007','QM-20260418-008','QM-20260418-007','QM-20260518-011','QM-20260518-009','QM-20260518-012','QM-20260519-003','QM-20260518-013','QM-20260518-001','QM-20260518-014','QM-20260518-015'] },
  '待发货(到尾查)': { keys: UP_QC, nos: ['QM-20260402-010'] },
  '生产中(到开裁)': { keys: UP_KICK, nos: ['QM-20260516-010','QM-20260516-011','QM-20260518-016','QM-20260618-008','QM-20260516-004','QM-20260605-003','QM-20260605-002','QM-20260618-009'] },
  '物料在途(到采购下单)': { keys: UP_PROC, nos: ['QM-20260518-022','QM-20260518-023','QM-20260518-024','QM-20260520-004','QM-20260516-012','QM-20260516-016','QM-20260516-009','QM-20260516-013','QM-20260516-015','QM-20260519-005','QM-20260519-006','QM-20260519-007','QM-20260519-008','QM-20260519-009','QM-20260519-010','QM-20260519-011','QM-20260519-012','QM-20260519-014','QM-20260519-018','QM-20260519-020','QM-20260519-022','QM-20260520-001','QM-20260520-003','QM-20260520-007','QM-20260521-001','QM-20260522-001','QM-20260522-002','QM-20260522-004','QM-20260522-006','QM-20260522-008','QM-20260516-002','QM-20260601-001','QM-20260611-001','QM-20260618-013','QM-20260618-011','QM-20260623-001','QM-20260703-019','QM-20260703-017','QM-20260703-018','QM-20260516-007','QM-20260704-001','QM-20260703-016','QM-20260703-013','QM-20260618-004','QM-20260618-002','QM-20260618-010','QM-20260618-007','QM-20260623-002','QM-20260516-003','QM-20260519-016','QM-20260520-008','QM-20260621-001','QM-20260403-018'] },
  '新订单待采购(仅激活)': { keys: [], nos: ['QM-20260518-025','QM-20260704-003','QM-20260703-021','QM-20260516-006','QM-20260516-005'] },
};

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return html('<b>未登录</b>');
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!roles.includes('admin')) return html('<b>仅管理员可用</b>');

  const apply = req.nextUrl.searchParams.get('confirm') === 'APPLY';
  const svc = createServiceRoleClient();
  let out = `<h2>${apply ? '✅ 已应用' : '👀 预演(未改动)'} —— 据 Excel 更新老单里程碑</h2>`;
  if (!apply) out += `<p>确认无误后,打开加 <code>?confirm=APPLY</code> 真正执行。</p>`;

  for (const [label, spec] of Object.entries(ORDERS)) {
    // 1) order_no → order_id + lifecycle
    const { data: ords } = await (svc.from('orders') as any)
      .select('id, order_no, internal_order_no, lifecycle_status').in('order_no', spec.nos);
    const found = (ords || []) as any[];
    const foundNos = new Set(found.map((o) => o.order_no));
    const missing = spec.nos.filter((n) => !foundNos.has(n));
    let msSet = 0, actd = 0, compd = 0;
    let msErr = '', actErr = '';

    // 诊断:该组第一单的 lifecycle + 里程碑真实 step_key/status(揭示为何 0 行)
    const sample = found[0];
    let sampleDump = '';
    if (sample) {
      const { data: sm } = await (svc.from('milestones') as any)
        .select('step_key, status').eq('order_id', sample.id).order('sort_order', { ascending: true });
      const lifes = Array.from(new Set(found.map((o) => o.lifecycle_status))).join(' / ');
      sampleDump = `<tr><td>找到单的 lifecycle 值</td><td class="m">${esc(lifes)}</td></tr>
        <tr><td>样本 ${esc(sample.order_no)} 里程碑<br>(step_key : status)</td><td class="m">${
          (sm || []).length ? (sm as any[]).map((x) => `${esc(x.step_key)} : ${esc(x.status)}`).join('<br>') : '❌ 该单没有任何里程碑'
        }</td></tr>`;
    }

    if (apply && found.length) {
      const ids = found.map((o) => o.id);
      // 激活(pending_approval/待审批/draft → active),已出货则 completed
      if (spec.complete) {
        const { data: c, error: ce } = await (svc.from('orders') as any).update({ lifecycle_status: 'completed' })
          .not('lifecycle_status', 'in', '("completed","已完成","cancelled","已取消")').in('id', ids).select('id');
        compd = (c || []).length; actErr = ce?.message || '';
      } else {
        const { data: a, error: ae } = await (svc.from('orders') as any).update({ lifecycle_status: 'active' })
          .in('lifecycle_status', ['pending_approval', '待审批', 'draft']).in('id', ids).select('id');
        actd = (a || []).length; actErr = ae?.message || '';
      }
      // 里程碑
      if (spec.keys === 'ALL') {
        const { data: m, error: me } = await (svc.from('milestones') as any).update({ status: 'done', actual_at: new Date().toISOString() })
          .in('order_id', ids).not('status', 'in', '("done","已完成","completed")').select('id');
        msSet = (m || []).length; msErr = me?.message || '';
      } else if (spec.keys.length) {
        const { data: m, error: me } = await (svc.from('milestones') as any).update({ status: 'done', actual_at: new Date().toISOString() })
          .in('order_id', ids).in('step_key', spec.keys).not('status', 'in', '("done","已完成","completed")').select('id');
        msSet = (m || []).length; msErr = me?.message || '';
      }
    }

    out += `<h3>${esc(label)} — Excel ${spec.nos.length} 单</h3><table>
      <tr><td>系统里找到</td><td>${found.length} 单</td></tr>
      <tr><td>Excel 里有但系统没有</td><td class="${missing.length ? 'r' : 'm'}">${missing.length ? esc(missing.join(', ')) : '无'}</td></tr>
      ${sampleDump}`;
    if (apply) out += `<tr><td>本次动作</td><td class="g">${spec.complete ? `标完成 ${compd} 单` : `激活 ${actd} 单`} · 里程碑置 done ${msSet} 条</td></tr>`;
    if (msErr || actErr) out += `<tr><td>报错</td><td class="r">${esc(actErr)} ${esc(msErr)}</td></tr>`;
    out += `</table>`;
  }
  out += `<p class="m">说明:已出货不发财务(SQL/后端此处不补);采购中心需真实采购行(此更新不含);开生产待排单并入物料在途。跑完刷新生产中心即对。</p>`;
  return html(out);
}

function html(body: string) {
  return new NextResponse(`<!doctype html><meta charset="utf-8"><style>body{font:14px/1.6 -apple-system,sans-serif;padding:24px;max-width:900px;margin:auto}h3{margin:20px 0 6px}table{border-collapse:collapse;margin:4px 0}td{border:1px solid #ddd;padding:3px 8px}code{background:#f4f4f4;padding:1px 4px;border-radius:3px}.g{color:#059669}.r{color:#dc2626}.m{color:#6b7280}</style>${body}`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
