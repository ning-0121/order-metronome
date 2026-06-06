// ============================================================
// GET /api/admin/diag-orders
// 一次性「全订单数据异常」诊断（只读，admin only）
// v2：milestones / confirmations 分页拉全，修掉 1000 行截断。
// ⚠️ 临时诊断接口，确认后删除。
// ============================================================

import { NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAdminRole } from '@/lib/domain/roles';

const STUCK_APPROVAL_DAYS = 7;

async function fetchAll(sys: any, table: string, cols: string): Promise<any[]> {
  const all: any[] = [];
  let from = 0;
  const size = 1000;
  // 最多 50 页（5 万行）保险
  for (let page = 0; page < 50; page++) {
    const { data, error } = await (sys.from(table) as any).select(cols).range(from, from + size - 1);
    if (error || !data || data.length === 0) break;
    all.push(...data);
    if (data.length < size) break;
    from += size;
  }
  return all;
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  if (!isAdminRole(roles)) return NextResponse.json({ error: '仅管理员可运行诊断' }, { status: 403 });

  const sys = createServiceRoleClient();
  const now = Date.now();
  const DONE = new Set(['done', '已完成', 'completed']);
  const sample = (arr: string[], n = 15) => arr.slice(0, n);
  const isActive = (s: string) => !['completed', '已完成', 'cancelled', '已取消', 'draft'].includes(s);

  const [orders, milestones, docs, fins, confs] = await Promise.all([
    fetchAll(sys, 'orders', 'id, order_no, lifecycle_status, created_at'),
    fetchAll(sys, 'milestones', 'order_id, status'),
    fetchAll(sys, 'order_documents', 'order_id, document_type, is_official'),
    fetchAll(sys, 'order_financials', 'order_id'),
    fetchAll(sys, 'order_confirmations', 'order_id, module'),
  ]);

  const noById = new Map<string, string>();
  for (const o of orders) noById.set(o.id, o.order_no);
  const finIds = new Set(fins.map((f: any) => f.order_id));

  const confCount = new Map<string, number>();
  for (const c of confs) confCount.set(c.order_id, (confCount.get(c.order_id) || 0) + 1);

  const msByOrder = new Map<string, any[]>();
  for (const m of milestones) {
    if (!msByOrder.has(m.order_id)) msByOrder.set(m.order_id, []);
    msByOrder.get(m.order_id)!.push(m);
  }

  // 1) active 缺 financials
  const missingFinancials: string[] = [];
  // 2) confirmations < 4
  const incompleteConfirmations: string[] = [];
  // 3) 待审批 > 7 天
  const stuckPendingApproval: string[] = [];
  // 5) 全节点 done 但订单未完成
  const allDoneButNotCompleted: string[] = [];

  for (const o of orders) {
    if (o.lifecycle_status === 'pending_approval') {
      const ageDays = (now - new Date(o.created_at).getTime()) / 86400000;
      if (ageDays > STUCK_APPROVAL_DAYS) stuckPendingApproval.push(`${o.order_no}(${Math.floor(ageDays)}天)`);
    }
    if (!isActive(o.lifecycle_status)) continue;
    if (!finIds.has(o.id)) missingFinancials.push(o.order_no);
    if ((confCount.get(o.id) || 0) < 4) incompleteConfirmations.push(`${o.order_no}(${confCount.get(o.id) || 0}/4)`);
    const ms = msByOrder.get(o.id) || [];
    if (ms.length > 0 && ms.every(m => DONE.has(String(m.status)))) allDoneButNotCompleted.push(o.order_no);
  }

  // 4) 单证正式版异常（同 order_id+type 0 个或 ≥2 个 official）
  const grp = new Map<string, { total: number; official: number; order_id: string; type: string }>();
  for (const d of docs) {
    const k = `${d.order_id}__${d.document_type}`;
    if (!grp.has(k)) grp.set(k, { total: 0, official: 0, order_id: d.order_id, type: d.document_type });
    const g = grp.get(k)!;
    g.total++;
    if (d.is_official === true) g.official++;
  }
  const docOfficialAnomaly: string[] = [];
  for (const g of grp.values()) {
    const no = noById.get(g.order_id) || g.order_id;
    if (g.total > 0 && g.official === 0) docOfficialAnomaly.push(`${no}/${g.type}(0个)`);
    if (g.official >= 2) docOfficialAnomaly.push(`${no}/${g.type}(${g.official}个)`);
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    totals: { orders: orders.length, milestones: milestones.length, documents: docs.length, confirmations: confs.length },
    summary: {
      '1_active缺financials': missingFinancials.length,
      '2_confirmations少于4': incompleteConfirmations.length,
      '3_待审批超7天': stuckPendingApproval.length,
      '4_单证正式版异常': docOfficialAnomaly.length,
      '5_全节点done未完成': allDoneButNotCompleted.length,
    },
    details: {
      '1_active缺financials': { count: missingFinancials.length, sample: sample(missingFinancials) },
      '2_confirmations少于4': { count: incompleteConfirmations.length, sample: sample(incompleteConfirmations) },
      '3_待审批超7天': { count: stuckPendingApproval.length, sample: sample(stuckPendingApproval) },
      '4_单证正式版异常': { count: docOfficialAnomaly.length, sample: sample(docOfficialAnomaly) },
      '5_全节点done未完成': { count: allDoneButNotCompleted.length, sample: sample(allDoneButNotCompleted) },
    },
  });
}
