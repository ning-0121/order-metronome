'use server';

// ============================================================
// 生产日报入口 —— 粘贴群里的日报 → 解析 → 订单匹配 → 预览确认 → 落订单动态(+可选标节点)
//
// 分两步(读写分离,评审可见):
//   parseProductionDailyReport(text)  只读,返回预览(不写任何东西)
//   applyProductionDailyReport(rows)  人确认后才写:每条进 order_notes_log(生产动态);
//                                     "完成"且唯一命中节点且勾了的,走 markMilestoneDone 标节点。
//
// 安全:改进度前必经人在预览里确认;标节点复用规范入口 markMilestoneDone(同权限+触发置信度/考核);
//   受阻不自动改置信度,只入动态(category='delay')。AI 不参与,纯规则解析(系统计算·人决策)。
// ============================================================

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import {
  parseDailyReport, resolveOrder, matchProcessToMilestone, STATUS_META,
  type OrderRef, type MilestoneRef, type ReportStatus,
} from '@/lib/production/dailyReport';

const IExec = ['admin', 'production', 'production_manager', 'merchandiser', 'order_manager', 'qc'];

async function authRoles() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, user: null, roles: [] as string[] };
  const { getUserRoles } = await import('@/lib/utils/user-role');
  const roles = await getUserRoles(supabase, user.id);   // 角色读收口(不在业务层直连 profiles)
  return { supabase, user, roles };
}

export interface DailyReportPreviewRow {
  raw: string;
  orderToken: string | null;
  process: string | null;
  status: ReportStatus | null;
  date: string | null;
  note: string;
  // 订单匹配
  orderId: string | null;
  matchedNo: string | null;
  orderHow: string;
  orderCandidates: Array<{ id: string; label: string }>;
  // 节点匹配(仅"完成"行才算)
  milestoneId: string | null;
  milestoneName: string | null;
  nodeHow: string;                 // unique | none | ambiguous | already-done | n/a
  suggestCompleteNode: boolean;    // 预览默认是否勾"标节点完成"
  category: 'general' | 'delay' | 'quality';
  problem: string | null;          // 该行无法处理的原因(订单没对上等)
}

/** 只读:粘贴日报 → 解析 + 匹配,返回逐行预览。不写任何数据。 */
export async function parseProductionDailyReport(text: string): Promise<{ rows?: DailyReportPreviewRow[]; error?: string }> {
  const { user, roles } = await authRoles();
  if (!user) return { error: '请先登录' };
  if (!roles.some((r) => IExec.includes(r))) return { error: '仅生产/理单/QC/管理员可录入生产日报' };
  if (!text || !text.trim()) return { error: '请粘贴日报内容' };

  const svc = createServiceRoleClient();
  const { listOrderRefs } = await import('@/lib/repositories/ordersRepo');
  const { data: orders, error: oErr } = await listOrderRefs(svc);   // 读收口:repo
  if (oErr) return { error: `读取订单失败:${oErr}` };

  const parsed = parseDailyReport(text);

  // 批量预取命中订单的里程碑(一次查,避免逐行往返)—— 走 repo getMilestonesByOrderIds
  const hitOrderIds = [...new Set(parsed.map((p) => resolveOrder(p.orderToken, orders).orderId).filter(Boolean) as string[])];
  const msByOrder = new Map<string, MilestoneRef[]>();
  if (hitOrderIds.length) {
    const { getMilestonesByOrderIds } = await import('@/lib/repositories/milestonesRepo');
    const { data: ms } = await getMilestonesByOrderIds(svc, hitOrderIds, 'id, order_id, step_key, name, status');
    for (const m of (ms || []) as any[]) {
      const arr = msByOrder.get(m.order_id) || [];
      arr.push({ id: m.id, stepKey: m.step_key, name: m.name ?? null, status: m.status });
      msByOrder.set(m.order_id, arr);
    }
  }

  const rows: DailyReportPreviewRow[] = parsed.map((p) => {
    const res = resolveOrder(p.orderToken, orders);
    const statusMeta = p.status ? STATUS_META[p.status] : null;
    let milestoneId: string | null = null, milestoneName: string | null = null, nodeHow = 'n/a', suggest = false;
    if (res.orderId && p.status === '完成') {
      const mm = matchProcessToMilestone(p.process, msByOrder.get(res.orderId) || []);
      milestoneId = mm.milestoneId; milestoneName = mm.milestoneName; nodeHow = mm.how;
      suggest = mm.how === 'unique';   // 只有唯一命中且未完成才默认勾
    }
    let problem: string | null = null;
    if (p.parseError) problem = p.parseError;
    else if (!res.orderId) problem = res.how === 'ambiguous' ? '订单号命中多条,请选' : '订单号没对上,请选或补正';
    return {
      raw: p.raw, orderToken: p.orderToken, process: p.process, status: p.status, date: p.date, note: p.note,
      orderId: res.orderId, matchedNo: res.matchedNo, orderHow: res.how,
      orderCandidates: res.candidates.map((c) => ({ id: c.id, label: `${c.internalNo || c.orderNo}·${c.customer || '?'}` })),
      milestoneId, milestoneName, nodeHow, suggestCompleteNode: suggest,
      category: statusMeta?.category ?? 'general', problem,
    };
  });

  return { rows };
}

export interface DailyReportApplyRow {
  orderId: string;           // 人确认/选定后的订单 id(必须有,否则跳过)
  process: string | null;
  status: ReportStatus | null;
  date: string | null;
  note: string;
  category: 'general' | 'delay' | 'quality';
  milestoneId?: string | null;   // 要标完成的节点(可空)
  completeNode?: boolean;        // 人是否勾了"同时标节点完成"
}

/** 人确认后写入:每条进订单动态;勾了的"完成"行标节点(走 markMilestoneDone)。 */
export async function applyProductionDailyReport(rows: DailyReportApplyRow[]): Promise<{
  ok?: boolean; error?: string;
  summary?: { notes: number; nodesCompleted: number; skipped: number; nodeErrors: string[] };
}> {
  const { user, roles } = await authRoles();
  if (!user) return { error: '请先登录' };
  if (!roles.some((r) => IExec.includes(r))) return { error: '仅生产/理单/QC/管理员可录入生产日报' };
  if (!Array.isArray(rows) || rows.length === 0) return { error: '没有可应用的条目' };

  const { addOrderNote } = await import('@/app/actions/order-notes');
  const { markMilestoneDone } = await import('@/app/actions/milestones');

  let notes = 0, nodesCompleted = 0, skipped = 0;
  const nodeErrors: string[] = [];

  for (const r of rows) {
    if (!r.orderId) { skipped++; continue; }
    // 组装动态内容:工序/状态/日期 前缀 + 说明,保留他们的原话
    const head = [r.process, r.status, r.date].filter(Boolean).join(' / ');
    const content = head ? `[${head}] ${r.note || ''}`.trim() : (r.note || '').trim();
    if (content) {
      const nr = await addOrderNote(r.orderId, content, r.category || 'general', r.milestoneId || undefined);
      if (!(nr as any).error) notes++;
      else nodeErrors.push(`动态写入失败(${r.note?.slice(0, 12)}…):${(nr as any).error}`);
    }
    // 标节点:仅当人勾了 + 有节点 + 状态完成
    if (r.completeNode && r.milestoneId && r.status === '完成') {
      const mr = await markMilestoneDone(r.milestoneId, null, null);
      if (!(mr as any)?.error) nodesCompleted++;
      else nodeErrors.push(`标节点失败(${r.process || ''}):${(mr as any).error}`);
    }
  }

  return { ok: true, summary: { notes, nodesCompleted, skipped, nodeErrors } };
}
