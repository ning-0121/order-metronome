// ============================================================
// GET /api/admin/diag-orders
// 一次性「全订单数据异常」诊断（只读，admin only）
// 用 service-role 扫库，输出各异常类的 count + 样本 order_no。
// ⚠️ 临时诊断接口，诊断完应删除（见 CLAUDE.md 调试规程）。
// ============================================================

import { NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAdminRole } from '@/lib/domain/roles';

const STUCK_APPROVAL_DAYS = 7;

export async function GET() {
  // ── 鉴权：仅 admin ──
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  if (!isAdminRole(roles)) return NextResponse.json({ error: '仅管理员可运行诊断' }, { status: 403 });

  const sys = createServiceRoleClient();
  const now = Date.now();
  const DONE = new Set(['done', '已完成', 'completed']);
  const sample = (arr: string[], n = 12) => arr.slice(0, n);

  // ── 拉数据（service-role，bypass RLS）──
  const [ordersRes, milestonesRes, docsRes, finRes, confRes, delaysRes] = await Promise.all([
    (sys.from('orders') as any).select('id, order_no, lifecycle_status, created_at'),
    (sys.from('milestones') as any).select('order_id, name, status, sequence_number'),
    (sys.from('order_documents') as any).select('order_id, document_type, is_official, status'),
    (sys.from('order_financials') as any).select('order_id'),
    (sys.from('order_confirmations') as any).select('order_id, module'),
    (sys.from('delay_requests') as any).select('order_id, status'),
  ]);

  const orders: any[] = ordersRes.data || [];
  const milestones: any[] = milestonesRes.data || [];
  const docs: any[] = docsRes.data || [];
  const fins: any[] = finRes.data || [];
  const confs: any[] = confRes.data || [];
  const delays: any[] = delaysRes.data || [];

  const noById = new Map<string, string>();
  for (const o of orders) noById.set(o.id, o.order_no);
  const isActive = (s: string) => !['completed', '已完成', 'cancelled', '已取消', 'draft'].includes(s);

  // 按订单聚合里程碑
  const msByOrder = new Map<string, any[]>();
  for (const m of milestones) {
    if (!msByOrder.has(m.order_id)) msByOrder.set(m.order_id, []);
    msByOrder.get(m.order_id)!.push(m);
  }

  // 1) 节点缺 name / sequence_number
  const missingNodeFieldOrders = new Set<string>();
  for (const m of milestones) {
    if (m.name == null || m.name === '' || m.sequence_number == null) {
      const no = noById.get(m.order_id);
      if (no) missingNodeFieldOrders.add(no);
    }
  }

  // 2) 全节点 done 但订单未完成（forceComplete 遗留）
  const allDoneButNotCompleted: string[] = [];
  for (const o of orders) {
    if (!isActive(o.lifecycle_status)) continue;
    const ms = msByOrder.get(o.id) || [];
    if (ms.length > 0 && ms.every(m => DONE.has(String(m.status)))) {
      allDoneButNotCompleted.push(o.order_no);
    }
  }

  // 3) 卡死待审批 > N 天
  const stuckPendingApproval: string[] = [];
  for (const o of orders) {
    if (o.lifecycle_status !== 'pending_approval') continue;
    const ageDays = (now - new Date(o.created_at).getTime()) / 86400000;
    if (ageDays > STUCK_APPROVAL_DAYS) stuckPendingApproval.push(`${o.order_no}(${Math.floor(ageDays)}天)`);
  }

  // 4) 单证 0 或 ≥2 个正式版（按 order_id + document_type 分组）
  const officialCount = new Map<string, { total: number; official: number; order_id: string; type: string }>();
  for (const d of docs) {
    const key = `${d.order_id}__${d.document_type}`;
    if (!officialCount.has(key)) officialCount.set(key, { total: 0, official: 0, order_id: d.order_id, type: d.document_type });
    const g = officialCount.get(key)!;
    g.total++;
    if (d.is_official === true) g.official++;
  }
  const zeroOfficial: string[] = [];
  const multiOfficial: string[] = [];
  for (const g of officialCount.values()) {
    const no = noById.get(g.order_id) || g.order_id;
    if (g.official === 0 && g.total > 0) zeroOfficial.push(`${no}/${g.type}`);
    if (g.official >= 2) multiOfficial.push(`${no}/${g.type}(${g.official})`);
  }

  // 5) active 订单缺 order_financials
  const finOrderIds = new Set(fins.map(f => f.order_id));
  const missingFinancials: string[] = [];
  for (const o of orders) {
    if (!isActive(o.lifecycle_status)) continue;
    if (!finOrderIds.has(o.id)) missingFinancials.push(o.order_no);
  }

  // 6) 确认行不全（< 4 个模块）
  const confByOrder = new Map<string, Set<string>>();
  for (const c of confs) {
    if (!confByOrder.has(c.order_id)) confByOrder.set(c.order_id, new Set());
    confByOrder.get(c.order_id)!.add(c.module);
  }
  const incompleteConfirmations: string[] = [];
  for (const o of orders) {
    if (!isActive(o.lifecycle_status)) continue;
    const n = confByOrder.get(o.id)?.size || 0;
    if (n < 4) incompleteConfirmations.push(`${o.order_no}(${n}/4)`);
  }

  // 7) delay_requests 状态异常（非 pending/approved/rejected）
  const badDelayStatus: string[] = [];
  const validDelay = new Set(['pending', 'approved', 'rejected']);
  for (const d of delays) {
    if (!validDelay.has(String(d.status))) {
      const no = noById.get(d.order_id) || d.order_id;
      badDelayStatus.push(`${no}(${d.status})`);
    }
  }

  const report = {
    ran_at: new Date().toISOString(),
    totals: { orders: orders.length, milestones: milestones.length, documents: docs.length },
    findings: {
      '1_节点缺name或sequence': { count: missingNodeFieldOrders.size, sample: sample([...missingNodeFieldOrders]) },
      '2_全节点done但订单未完成': { count: allDoneButNotCompleted.length, sample: sample(allDoneButNotCompleted) },
      '3_卡死待审批超7天': { count: stuckPendingApproval.length, sample: sample(stuckPendingApproval) },
      '4a_单证0个正式版': { count: zeroOfficial.length, sample: sample(zeroOfficial) },
      '4b_单证多个正式版': { count: multiOfficial.length, sample: sample(multiOfficial) },
      '5_active订单缺financials': { count: missingFinancials.length, sample: sample(missingFinancials) },
      '6_确认行不全': { count: incompleteConfirmations.length, sample: sample(incompleteConfirmations) },
      '7_delay状态异常': { count: badDelayStatus.length, sample: sample(badDelayStatus) },
    },
  };

  return NextResponse.json(report, { status: 200 });
}
