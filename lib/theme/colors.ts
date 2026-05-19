/**
 * UI 颜色 token — 单一真相来源
 *
 * 业务背景：之前订单类型颜色 map 在 app/orders/page.tsx 和
 * app/orders/[id]/page.tsx 一字不差复制了两份，加急用红色但同色又表示
 * 「风险订单」状态，CEO 反馈过混淆。
 *
 * 维度划分（避免颜色复用混淆）：
 *   - 状态色 STATUS_COLORS：GREEN/YELLOW/RED — 表示"健康度/风险等级"
 *   - 订单类型 ORDER_TYPE_COLORS：trial/bulk/repeat/urgent/sample — 表示"业务分类"
 *   - 严重度 SEVERITY_COLORS：critical/high/medium/low — 表示"事件严重程度"
 *
 * 命名约定：
 *   - bgSoft  浅底色（卡片背景、徽章背景）
 *   - text    主文字色
 *   - border  边框色
 *   - badge   组合 className（bg + text，给徽章直接用）
 *
 * 使用：
 *   import { ORDER_TYPE_COLORS } from '@/lib/theme/colors';
 *   <span className={ORDER_TYPE_COLORS[order.order_type].badge}>...</span>
 */

// ──────────────────────────────────────────
// 状态色 — 风险/健康度三色
// ──────────────────────────────────────────
export type StatusLevel = 'GREEN' | 'YELLOW' | 'RED';

export const STATUS_COLORS: Record<StatusLevel, {
  bgSoft: string;
  text: string;
  border: string;
  badge: string;
}> = {
  GREEN:  { bgSoft: 'bg-green-50',  text: 'text-green-700',  border: 'border-green-300',  badge: 'bg-green-100 text-green-700' },
  YELLOW: { bgSoft: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-300', badge: 'bg-yellow-100 text-yellow-700' },
  RED:    { bgSoft: 'bg-red-50',    text: 'text-red-700',    border: 'border-red-300',    badge: 'bg-red-100 text-red-700' },
};

// ──────────────────────────────────────────
// 订单类型 — 业务分类
// ──────────────────────────────────────────
export type OrderTypeKey = 'trial' | 'bulk' | 'repeat' | 'urgent' | 'sample';

export const ORDER_TYPE_LABELS: Record<OrderTypeKey, string> = {
  trial: '试单',
  bulk: '正常',
  repeat: '翻单',
  urgent: '加急',
  sample: '样品',
};

export const ORDER_TYPE_COLORS: Record<OrderTypeKey, {
  badge: string;
}> = {
  // 注意：urgent 用红色仍然 OK，因为「加急订单」本身就是一种风险信号；
  // 上下文用 ORDER_TYPE_LABELS 配合，业务能区分类型 vs 风险
  trial:  { badge: 'bg-blue-100 text-blue-700' },
  bulk:   { badge: 'bg-gray-100 text-gray-700' },
  repeat: { badge: 'bg-green-100 text-green-700' },
  urgent: { badge: 'bg-red-100 text-red-700' },
  sample: { badge: 'bg-purple-100 text-purple-700' },
};

/** 取订单类型的徽章 className，未知类型回退中性灰 */
export function getOrderTypeBadge(orderType: string | null | undefined): string {
  if (!orderType) return ORDER_TYPE_COLORS.bulk.badge;
  const key = orderType as OrderTypeKey;
  return ORDER_TYPE_COLORS[key]?.badge || ORDER_TYPE_COLORS.bulk.badge;
}

/** 取订单类型的中文标签，未知返回原值 */
export function getOrderTypeLabel(orderType: string | null | undefined): string {
  if (!orderType) return '—';
  return ORDER_TYPE_LABELS[orderType as OrderTypeKey] || orderType;
}

// ──────────────────────────────────────────
// 严重度色 — 事件优先级
// ──────────────────────────────────────────
export type Severity = 'critical' | 'high' | 'medium' | 'low';

export const SEVERITY_COLORS: Record<Severity, { badge: string; emoji: string }> = {
  critical: { badge: 'bg-red-100 text-red-700',    emoji: '🚨' },
  high:     { badge: 'bg-orange-100 text-orange-700', emoji: '⚠️' },
  medium:   { badge: 'bg-amber-100 text-amber-700',   emoji: '⚡' },
  low:      { badge: 'bg-blue-100 text-blue-700',     emoji: 'ℹ️' },
};
