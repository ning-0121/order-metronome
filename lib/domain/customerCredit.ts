/**
 * Customer Credit Tier — 客户信用分级 SSOT
 *
 * 国际外贸标准：根据客户历史决定付款条款
 *   - 新客户首单 → 100% 预付 / LC at sight（风险最高，未建立信任）
 *   - 老客户少单 → 30/70 或 50/50（建立信任期）
 *   - 老客户稳定 → 30/70 或 OA 30 days（成熟期）
 *   - 老客户出过事 → 回到 100% 预付（信用降级）
 *
 * 本 helper 不写数据库，纯派生计算。基于 customer_rhythm.total_order_count
 * + customer_rhythm.overdue_payments 实时算出 credit_tier。
 *
 * 应用：
 *   - 新订单创建时显示风险 banner
 *   - 推荐的付款条款（提醒，不强制）
 */

export type CreditTier =
  | 'new'         // 新客户：0 单历史
  | 'emerging'    // 新兴客户：1-3 单，尚未稳定
  | 'established' // 成熟客户：4+ 单 + 无延付
  | 'watch';      // 关注客户：有延付 / 高 risk_score

export interface CreditTierInput {
  /** customer_rhythm.total_order_count */
  totalOrderCount?: number | null;
  /** customer_rhythm.overdue_payments — 历史延付次数 */
  overduePayments?: number | null;
  /** customer_rhythm.risk_score（0-100，越高越差）*/
  riskScore?: number | null;
}

export interface CreditTierResult {
  tier: CreditTier;
  label: string;
  /** 推荐付款条款 */
  recommendedTerms: string;
  /** 风险描述（给业务/admin 看的一句话） */
  risk: string;
  /** 是否要 admin 介入审批 */
  requiresAdminApproval: boolean;
  /** UI 颜色 hint：red / amber / green / blue */
  color: 'red' | 'amber' | 'green' | 'blue';
}

export function computeCreditTier(input: CreditTierInput): CreditTierResult {
  const total = Number(input.totalOrderCount || 0);
  const overdue = Number(input.overduePayments || 0);
  const risk = Number(input.riskScore || 0);

  // 有延付 → watch（不论单数多少，先降级）
  if (overdue > 0 || risk >= 70) {
    return {
      tier: 'watch',
      label: '⚠️ 关注客户',
      recommendedTerms: '100% 预付 / LC at sight（信用降级，仅在客户清账后恢复）',
      risk: `历史有 ${overdue} 次延付${risk >= 70 ? `，风险评分 ${risk}` : ''}。强烈建议恢复 100% 预付直到清账。`,
      requiresAdminApproval: true,
      color: 'red',
    };
  }

  // 0 单 → 新客户首单
  if (total === 0) {
    return {
      tier: 'new',
      label: '🆕 新客户首单',
      recommendedTerms: '100% 预付 / LC at sight / 30%T/T 见提单复印件',
      risk: '该客户为首次合作，无历史信用数据。强烈建议要求 100% 预付或开 LC，避免坏账。',
      requiresAdminApproval: true,
      color: 'red',
    };
  }

  // 1-3 单 → 新兴客户
  if (total <= 3) {
    return {
      tier: 'emerging',
      label: '🌱 新兴客户',
      recommendedTerms: '30/70 或 50/50（30% 定金 + 70% 见提单复印件 或 50% 定金 + 50% 见提单）',
      risk: `已合作 ${total} 单，信用基础正在建立。建议保持预付 + 见单尾款，避免 OA。`,
      requiresAdminApproval: false,
      color: 'amber',
    };
  }

  // 4+ 单 + 无延付 → 成熟客户
  return {
    tier: 'established',
    label: '✅ 成熟客户',
    recommendedTerms: '30/70 或 OA 30 days（已建立信用，可考虑账期）',
    risk: `已合作 ${total} 单，无延付历史。可根据议价权考虑账期，但建议大单仍要求一定比例预付。`,
    requiresAdminApproval: false,
    color: 'green',
  };
}
