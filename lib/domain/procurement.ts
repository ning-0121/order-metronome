/**
 * 采购中心 V1 — 采购行状态机 + 行级红黄绿灯 + 价格阈值（纯函数，零 IO）。
 * 契约：docs/procurement-center-design.md §4（状态机）、决策4（V1 价格只标色不阻断）。
 * 阈值为 2026-06-13 拍板默认值，可调。
 */

export type ProcurementLineStatus =
  | 'draft'
  | 'pending_order'
  | 'ordered'
  | 'confirmed'
  | 'in_production'
  | 'shipped'
  | 'arrived'
  | 'accepted'
  | 'concession'
  | 'rejected'
  | 'closed'
  | 'cancelled';

export const LINE_STATUS_LABELS: Record<ProcurementLineStatus, string> = {
  draft: '待计划',
  pending_order: '待下单',
  ordered: '已下单',
  confirmed: '已确认',
  in_production: '生产中',
  shipped: '已发货',
  arrived: '已到厂',
  accepted: '验收通过',
  concession: '让步接收',
  rejected: '拒收',
  closed: '已关闭',
  cancelled: '已取消',
};

/** 合法状态转换表。ordered→shipped 允许跳过 confirmed（小供应商不走确认）。 */
export const VALID_LINE_TRANSITIONS: Record<ProcurementLineStatus, ProcurementLineStatus[]> = {
  draft: ['pending_order', 'cancelled'],
  pending_order: ['ordered', 'cancelled'],
  ordered: ['confirmed', 'shipped', 'cancelled'],
  confirmed: ['in_production', 'shipped', 'cancelled'],
  in_production: ['shipped', 'cancelled'],
  shipped: ['arrived', 'cancelled'],
  arrived: ['accepted', 'concession', 'rejected'],
  accepted: ['closed'],
  concession: ['closed'],
  rejected: ['closed'], // 退货补料 = 开新行，原行关闭
  closed: [],
  cancelled: [],
};

export function isValidLineTransition(
  from: ProcurementLineStatus | string | null | undefined,
  to: ProcurementLineStatus,
): boolean {
  const f = (from || 'draft') as ProcurementLineStatus;
  return (VALID_LINE_TRANSITIONS[f] || []).includes(to);
}

/** 在途状态（进入催货/交期监控范围） */
export const ACTIVE_LINE_STATUSES: ProcurementLineStatus[] = [
  'ordered', 'confirmed', 'in_production', 'shipped',
];

// ── 拍板参数（2026-06-13，决策4 + 排期缓冲）──
export const PRICE_VARIANCE_YELLOW_PCT = 10; // 超历史基线 +10% 标黄
export const PRICE_VARIANCE_RED_PCT = 20;    // 超历史基线 +20% 标红（V1 不阻断）
export const REQUIRED_BY_BUFFER_DAYS = 3;    // 需到日 = 开裁/对应节点 due − 3 天
export const DEFAULT_LEAD_DAYS = 7;          // 品类无默认交期时的兜底 lead time
export const CHASE_ESCALATION_THRESHOLD = 3; // 催货 N 次无果 → 升级通知

export type LineLamp = 'green' | 'yellow' | 'red' | null;

const MS_PER_DAY = 86_400_000;

function daysUntil(target: string | Date, now: Date): number {
  const t = typeof target === 'string' ? new Date(target) : target;
  return Math.floor((t.getTime() - now.getTime()) / MS_PER_DAY);
}

/**
 * 行级红黄绿灯（与状态机正交，由日期差驱动）：
 * - 终态/已到厂/draft 或无 required_by → null（不亮灯）
 * - 有 eta（expected_arrival ?? promised_date）：required_by − eta <0 红 / 0–3 黄 / >3 绿
 * - 待下单无 eta：now vs (required_by − leadDays)，过点红 / 3 天内黄 / 其余绿（"再不下单就晚"）
 * - 在途无 eta：required_by − now，<0 红 / ≤3 黄 / 其余绿
 */
export function computeLineLamp(
  line: {
    line_status: string | null;
    required_by?: string | null;
    promised_date?: string | null;
    expected_arrival?: string | null;
  },
  opts?: { now?: Date; defaultLeadDays?: number | null },
): LineLamp {
  const status = (line.line_status || 'draft') as ProcurementLineStatus;
  const monitored: ProcurementLineStatus[] = ['pending_order', ...ACTIVE_LINE_STATUSES];
  if (!monitored.includes(status)) return null;
  if (!line.required_by) return null;

  const now = opts?.now ?? new Date();
  const eta = line.expected_arrival || line.promised_date;

  if (eta) {
    const margin = daysUntil(line.required_by, new Date(eta));
    if (margin < 0) return 'red';
    if (margin <= REQUIRED_BY_BUFFER_DAYS) return 'yellow';
    return 'green';
  }

  if (status === 'pending_order') {
    const lead = opts?.defaultLeadDays ?? DEFAULT_LEAD_DAYS;
    const slack = daysUntil(line.required_by, now) - lead; // 距"最晚下单日"的余量
    if (slack < 0) return 'red';
    if (slack <= REQUIRED_BY_BUFFER_DAYS) return 'yellow';
    return 'green';
  }

  const remain = daysUntil(line.required_by, now);
  if (remain < 0) return 'red';
  if (remain <= REQUIRED_BY_BUFFER_DAYS) return 'yellow';
  return 'green';
}

/** 价格偏差标色（V1 仅提示，决策4：不阻断流转） */
export function priceVarianceLevel(pct: number | null | undefined): 'red' | 'yellow' | null {
  if (pct === null || pct === undefined) return null;
  if (pct >= PRICE_VARIANCE_RED_PCT) return 'red';
  if (pct >= PRICE_VARIANCE_YELLOW_PCT) return 'yellow';
  return null;
}
