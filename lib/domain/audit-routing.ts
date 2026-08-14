// ============================================================
// 每日订单审计 —— 问题分类 · 阶段门槛 · 收件人路由(单一真相源)
// 2026-08-13 CEO 拍板:不再只发 admin 流水账,按问题类型分发到「行政督导 + 对口主管」。
// 改这里即可调整"谁该收哪类问题",不动 cron 引擎。
// ============================================================

import { deferralChainFor } from './deferral-routing';

/** 审计问题类型 —— 用 kind 分组,不用会带天数的展示文案(否则"3天未更新/17天未更新"被当成两类)。 */
export type AuditIssueKind =
  | 'missing_factory'        // 未指定工厂
  | 'factory_date_overdue'   // 出厂日已过仍未完成
  | 'milestone_overdue'      // 节点逾期
  | 'missing_internal_no'    // 缺内部单号
  | 'missing_merchandiser'   // 未指定跟单负责人
  | 'zero_quantity'          // 数量为 0
  | 'stale_order';           // 长期未更新

export const AUDIT_KIND_CN: Record<AuditIssueKind, string> = {
  missing_factory: '未指定工厂',
  factory_date_overdue: '出厂日已过未完成',
  milestone_overdue: '节点逾期',
  missing_internal_no: '缺内部单号',
  missing_merchandiser: '未指定跟单负责人',
  zero_quantity: '订单数量为 0',
  stale_order: '长期未更新',
};

/**
 * 静态收件人路由。
 * 行政督导(admin_assistant)看全部督办类;执行主管只收自己那摊。
 * milestone_overdue 的部门主管是**动态**的(按节点 owner_role),见 recipientRolesForIssue。
 */
export const AUDIT_ROUTING: Record<AuditIssueKind, string[]> = {
  missing_factory:      ['admin_assistant', 'production_manager'],
  factory_date_overdue: ['admin_assistant', 'order_manager'],
  milestone_overdue:    ['admin_assistant'], // + deferralChainFor(owner_role)
  // 以下三类仍是录入质量问题,不进主管督办,只汇总给 admin
  missing_internal_no:  [],
  missing_merchandiser: ['production_manager'], // 指派跟单本就是生产主管的活
  zero_quantity:        [],
  stale_order:          [],
};

/**
 * 取某条问题的收件角色(含动态部门主管)。
 * 节点逾期:除行政督导外,再加"逾期节点归口部门的主管"——复用延期审批那张表,不另立一套口径。
 */
export function recipientRolesForIssue(kind: AuditIssueKind, ownerRoles?: string[] | null): string[] {
  const base = AUDIT_ROUTING[kind] || [];
  if (kind !== 'milestone_overdue') return [...base];
  const dept = (ownerRoles?.length ? ownerRoles : [null]).flatMap((r) => deferralChainFor(r));
  return Array.from(new Set([...base, ...dept]));
}

/**
 * 「工厂早该定了」的阶段门槛。
 *
 * 背景(2026-08-13 实测):旧规则是"活跃单没填 factory_name 就报严重",62 条里 39 条
 * 其实还没走到定工厂的阶段 —— 61% 是假警报。这和早先"逾期虚高"是同一个病:
 * **把「还没到时候」当成「没做」**。噪音一大,主管两天就不看了。
 *
 * 口径:只要这些节点任一已完成,工厂就必然已知(要么已确认工厂,要么已向工厂下料/开裁),
 * 此时 orders.factory_name 还空 = 真缺失,必报。否则不报。
 */
export const FACTORY_MUST_BE_KNOWN_STEPS = [
  'factory_confirmed',            // 工厂匹配确认
  'procurement_order_placed',     // 采购订单下达
  'materials_received_inspected', // 原辅料到货验收
  'pre_production_meeting',       // 产前会
  'production_kickoff',           // 生产启动/开裁
  'factory_completion',           // 工厂完成
] as const;

const DONE_STATUSES = new Set(['done', '已完成', 'completed']);

/** 该订单是否已越过"工厂必须已知"的阶段。 */
export function factoryShouldBeKnown(
  milestones: Array<{ step_key?: string | null; status?: string | null }>,
): boolean {
  return (milestones || []).some(
    (m) =>
      FACTORY_MUST_BE_KNOWN_STEPS.includes(String(m?.step_key) as any) &&
      DONE_STATUSES.has(String(m?.status || '').toLowerCase()),
  );
}
