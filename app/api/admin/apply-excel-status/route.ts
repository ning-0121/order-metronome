// ============================================================
// GET /api/admin/apply-excel-status         → 预演(只报告不改)
// GET /api/admin/apply-excel-status?confirm=APPLY → 真应用 + 报告
// admin-only。据 生产订单一览(1).xlsx 一次性更新老单。
// 诊断发现:这些导入单【没有任何里程碑行】——所以生产中心无从派生,全落"待采购"。
// 修法:据 V2 九节点模板【创建】里程碑,按各单 Excel 阶段把对应节点置 done(其余 in_progress/pending)。
// 用 init_order_milestones RPC(app 同款,幂等 ON CONFLICT DO NOTHING)+ service-role。跳过已取消单。
// 一次性用,用完即弃。
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { MILESTONE_TEMPLATE_V2 } from '@/lib/milestoneTemplate';
import { calcDueDates } from '@/lib/schedule';
import { ensureBusinessDay } from '@/lib/utils/date';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const esc = (s: any) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
const V2KEYS = MILESTONE_TEMPLATE_V2.map((t) => t.step_key);

// doneThrough = V2 模板里"做到第几个(含)"的下标;-1=一个都没做;8=全做完(已出货)。
const ORDERS: Record<string, { doneThrough: number; complete?: boolean; nos: string[] }> = {
  '已出货→完成(全9节点done)': { doneThrough: 8, complete: true, nos: ['QM-20260414-003','QM-20260403-023','QM-20260406-006','QM-20260403-015','QM-20260403-028','QM-20260403-033','QM-20260518-007','QM-20260418-008','QM-20260418-007','QM-20260518-011','QM-20260518-009','QM-20260518-012','QM-20260519-003','QM-20260518-013','QM-20260518-001','QM-20260518-014','QM-20260518-015'] },
  '待发货(到尾查done)': { doneThrough: 6, nos: ['QM-20260402-010'] },
  '生产中(到开裁done)': { doneThrough: 5, nos: ['QM-20260516-010','QM-20260516-011','QM-20260518-016','QM-20260618-008','QM-20260516-004','QM-20260605-003','QM-20260605-002','QM-20260618-009'] },
  '物料在途(到采购下单done)': { doneThrough: 3, nos: ['QM-20260518-022','QM-20260518-023','QM-20260518-024','QM-20260520-004','QM-20260516-012','QM-20260516-016','QM-20260516-009','QM-20260516-013','QM-20260516-015','QM-20260519-005','QM-20260519-006','QM-20260519-007','QM-20260519-008','QM-20260519-009','QM-20260519-010','QM-20260519-011','QM-20260519-012','QM-20260519-014','QM-20260519-018','QM-20260519-020','QM-20260519-022','QM-20260520-001','QM-20260520-003','QM-20260520-007','QM-20260521-001','QM-20260522-001','QM-20260522-002','QM-20260522-004','QM-20260522-006','QM-20260522-008','QM-20260516-002','QM-20260601-001','QM-20260611-001','QM-20260618-013','QM-20260618-011','QM-20260623-001','QM-20260703-019','QM-20260703-017','QM-20260703-018','QM-20260516-007','QM-20260704-001','QM-20260703-016','QM-20260703-013','QM-20260618-004','QM-20260618-002','QM-20260618-010','QM-20260618-007','QM-20260623-002','QM-20260516-003','QM-20260519-016','QM-20260520-008','QM-20260621-001','QM-20260403-018'] },
  '新订单待采购(仅激活+建空节点)': { doneThrough: -1, nos: ['QM-20260518-025','QM-20260704-003','QM-20260703-021','QM-20260516-006','QM-20260516-005'] },
};

const CANCELLED = ['cancelled', '已取消', 'archived', '已归档'];

// 据模板 + doneThrough 生成一单的 9 条里程碑数据(含状态/日期)。
function buildMilestones(order: any, doneThrough: number) {
  const base = order.created_at ? new Date(order.created_at) : new Date();
  let dd: Record<string, any> = {};
  try {
    dd = calcDueDates({ createdAt: base, incoterm: (order.incoterm || 'FOB') as any, etd: order.etd, warehouseDueDate: order.warehouse_due_date }) as any;
  } catch { dd = {}; }
  return MILESTONE_TEMPLATE_V2.map((t, i) => {
    let d: Date;
    const raw = dd[t.step_key];
    if (raw) { try { d = ensureBusinessDay(new Date(raw)); } catch { d = new Date(base.getTime() + i * 3 * 864e5); } }
    else { d = new Date(base.getTime() + i * 3 * 864e5); }
    const status = i <= doneThrough ? 'done' : i === doneThrough + 1 ? 'in_progress' : 'pending';
    return {
      step_key: t.step_key, name: t.name, owner_role: t.owner_role, owner_user_id: null,
      planned_at: d.toISOString(), due_at: d.toISOString(), status,
      is_critical: t.is_critical, evidence_required: t.evidence_required, notes: null, sequence_number: i + 1,
    };
  });
}

async function chunked<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return html('<b>未登录</b>');
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!roles.includes('admin')) return html('<b>仅管理员可用</b>');

  const apply = req.nextUrl.searchParams.get('confirm') === 'APPLY';
  const svc = createServiceRoleClient();
  let out = `<h2>${apply ? '✅ 已应用' : '👀 预演(未改动)'} —— 据 Excel 建/补老单里程碑</h2>`;
  if (!apply) out += `<p>确认无误后,打开加 <code>?confirm=APPLY</code> 真正执行。</p>`;

  for (const [label, spec] of Object.entries(ORDERS)) {
    const { data: ords } = await (svc.from('orders') as any)
      .select('id, order_no, internal_order_no, lifecycle_status, created_at, incoterm, etd, warehouse_due_date').in('order_no', spec.nos);
    const all = (ords || []) as any[];
    const foundNos = new Set(all.map((o) => o.order_no));
    const missing = spec.nos.filter((n) => !foundNos.has(n));
    const cancelled = all.filter((o) => CANCELLED.includes(String(o.lifecycle_status)));
    const live = all.filter((o) => !CANCELLED.includes(String(o.lifecycle_status)));

    // 已有里程碑的单(≥1条)→ 只补状态;无里程碑的单 → 建全套
    let haveSet = new Set<string>();
    if (live.length) {
      const { data: ex } = await (svc.from('milestones') as any).select('order_id').in('order_id', live.map((o) => o.id));
      haveSet = new Set((ex || []).map((x: any) => x.order_id));
    }
    const toCreate = live.filter((o) => !haveSet.has(o.id));
    const toPatch = live.filter((o) => haveSet.has(o.id));

    let created = 0, patched = 0, errs: string[] = [];

    if (apply) {
      // 激活/标完成
      const ids = live.map((o) => o.id);
      if (ids.length) {
        if (spec.complete) await (svc.from('orders') as any).update({ lifecycle_status: 'completed' }).not('lifecycle_status', 'in', `(${CANCELLED.map((c) => `"${c}"`).join(',')})`).in('id', ids);
        else await (svc.from('orders') as any).update({ lifecycle_status: 'active' }).in('lifecycle_status', ['pending_approval', '待审批', 'draft']).in('id', ids);
      }
      // 建里程碑
      await chunked(toCreate, 8, async (o) => {
        const data = buildMilestones(o, spec.doneThrough);
        const { error } = await (svc.rpc as any)('init_order_milestones', { _order_id: o.id, _milestones_data: data });
        if (error) errs.push(`${o.order_no}:${error.message}`); else created++;
        // done 的补 actual_at(RPC 不设)
        await (svc.from('milestones') as any).update({ actual_at: o.created_at || new Date().toISOString() }).eq('order_id', o.id).eq('status', 'done').is('actual_at', null);
        return null;
      });
      // 补已有单的状态(把累计 done 键置 done)
      const doneKeys = V2KEYS.slice(0, spec.doneThrough + 1);
      await chunked(toPatch, 8, async (o) => {
        if (doneKeys.length) {
          const { error } = await (svc.from('milestones') as any).update({ status: 'done', actual_at: o.created_at || new Date().toISOString() })
            .eq('order_id', o.id).in('step_key', doneKeys).not('status', 'in', '("done","已完成","completed")');
          if (error) errs.push(`${o.order_no}:${error.message}`);
        }
        patched++;
        return null;
      });
    }

    out += `<h3>${esc(label)} — Excel ${spec.nos.length} 单</h3><table>
      <tr><td>系统找到 / 活跃 / 已取消跳过</td><td>${all.length} / ${live.length} / <span class="${cancelled.length ? 'r' : 'm'}">${cancelled.length}${cancelled.length ? '(' + esc(cancelled.map((o) => o.order_no).join(',')) + ')' : ''}</span></td></tr>
      <tr><td>无里程碑(将新建) / 已有(将补状态)</td><td>${toCreate.length} / ${toPatch.length}</td></tr>
      <tr><td>Excel 有但系统没有</td><td class="${missing.length ? 'r' : 'm'}">${missing.length ? esc(missing.join(', ')) : '无'}</td></tr>`;
    if (apply) out += `<tr><td>本次动作</td><td class="g">新建里程碑 ${created} 单 · 补状态 ${patched} 单</td></tr>`;
    if (errs.length) out += `<tr><td>报错</td><td class="r">${esc(errs.slice(0, 5).join(' | '))}</td></tr>`;
    out += `</table>`;
  }
  out += `<p class="m">已出货不发财务(先不补);采购中心需真实采购行(此更新不含);已取消单跳过不复活;部分出货3单+测试1单单独处理。跑完刷新生产中心即对。</p>`;
  return html(out);
}

function html(body: string) {
  return new NextResponse(`<!doctype html><meta charset="utf-8"><style>body{font:14px/1.6 -apple-system,sans-serif;padding:24px;max-width:960px;margin:auto}h3{margin:20px 0 6px}table{border-collapse:collapse;margin:4px 0}td{border:1px solid #ddd;padding:3px 8px}code{background:#f4f4f4;padding:1px 4px;border-radius:3px}.g{color:#059669}.r{color:#dc2626}.m{color:#6b7280}</style>${body}`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
