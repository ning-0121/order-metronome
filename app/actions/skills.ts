'use server';

/**
 * AI Skills Server Actions
 *
 * 所有 Skill 都通过这个文件对外暴露。
 * 内部走 lib/agent/skills/runner.ts 统一调度（缓存/熔断/日志/异常兜底）。
 */

import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { SKILL_FLAGS } from '@/lib/agent/featureFlags';
import { runSkill, invalidateOrderSkillCache } from '@/lib/agent/skills/runner';
import { missingInfoSkill } from '@/lib/agent/skills/missingInfo';
import { riskAssessmentSkill } from '@/lib/agent/skills/riskAssessment';
import { customerEmailInsightsSkill } from '@/lib/agent/skills/customerEmailInsights';
import { deliveryFeasibilitySkill } from '@/lib/agent/skills/deliveryFeasibility';
import type { SkillResult } from '@/lib/agent/skills/types';

/**
 * 权限检查：用户是否有权访问该订单的 AI Skill
 *
 * 允许：
 * - admin / finance / production_manager / admin_assistant（全公司可见角色）
 * - 订单创建者 (created_by)
 * - 跟单负责人 (owner_user_id)
 * - 该订单中分配了里程碑的负责人
 */
async function canAccessOrderSkill(supabase: any, orderId: string): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (isAdmin) return true;

  // 角色检查
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0
    ? (profile as any).roles
    : [(profile as any)?.role].filter(Boolean);

  // 全公司可见角色
  if (userRoles.some((r: string) => ['finance', 'production_manager', 'admin_assistant'].includes(r))) {
    return true;
  }

  // 订单所有权
  const { data: order } = await (supabase.from('orders') as any)
    .select('created_by, owner_user_id')
    .eq('id', orderId)
    .single();
  if (!order) return false;

  if (order.created_by === user.id) return true;
  if (order.owner_user_id === user.id) return true;

  // 该订单中是否有分配给当前用户的里程碑
  const { data: ms } = await (supabase.from('milestones') as any)
    .select('id')
    .eq('order_id', orderId)
    .eq('owner_user_id', user.id)
    .limit(1);
  if (ms && ms.length > 0) return true;

  return false;
}

/**
 * 跑「缺失资料检查」Skill
 *
 * 权限：admin / 财务/管理助理/生产主管 / 订单创建者 / 跟单 / 节点负责人
 * Feature flag：SKILL_MISSING_INFO=true 才生效
 */
export async function runMissingInfoCheck(orderId: string): Promise<{
  result?: SkillResult;
  error?: string;
  shadow?: boolean;
  cached?: boolean;
}> {
  if (!SKILL_FLAGS.missingInfo()) {
    return { error: 'Skill 未启用' };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const allowed = await canAccessOrderSkill(supabase, orderId);
  if (!allowed) return { error: '无权访问此订单的 AI Skill' };

  try {
    const output = await runSkill(missingInfoSkill, { orderId }, { triggeredBy: 'user' });
    if (output.circuitBroken) {
      return { error: 'Skill 已熔断（连续失败过多），请稍后重试' };
    }
    return {
      result: output.displayResult || undefined,
      shadow: output.displayResult === null && output.internalResult !== null,
      cached: output.cacheHit,
    };
  } catch (err: any) {
    console.error('[runMissingInfoCheck] outer error:', err?.message);
    return { error: 'Skill 运行异常' };
  }
}

/**
 * 跑「风险评估」Skill
 *
 * 12 维度规则评分 + AI 增强（可选）
 * 权限：同 runMissingInfoCheck
 * Feature flag：SKILL_RISK_ASSESSMENT=true 才生效
 */
export async function runRiskAssessment(orderId: string): Promise<{
  result?: SkillResult;
  error?: string;
  shadow?: boolean;
  cached?: boolean;
}> {
  if (!SKILL_FLAGS.riskAssessment()) {
    return { error: 'Skill 未启用' };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const allowed = await canAccessOrderSkill(supabase, orderId);
  if (!allowed) return { error: '无权访问此订单的 AI Skill' };

  try {
    const output = await runSkill(riskAssessmentSkill, { orderId }, { triggeredBy: 'user' });
    if (output.circuitBroken) {
      return { error: 'Skill 已熔断，请稍后重试' };
    }
    return {
      result: output.displayResult || undefined,
      shadow: output.displayResult === null && output.internalResult !== null,
      cached: output.cacheHit,
    };
  } catch (err: any) {
    console.error('[runRiskAssessment] outer error:', err?.message);
    return { error: 'Skill 运行异常' };
  }
}

/**
 * 跑「客户邮件洞察」Skill
 *
 * 扫描该订单客户最近 30 天邮件，识别被忽略的请求 + 生成下封邮件草稿
 * 权限：同 runMissingInfoCheck
 * Feature flag：SKILL_CUSTOMER_EMAIL_INSIGHTS=true 才生效
 */
export async function runCustomerEmailInsights(orderId: string): Promise<{
  result?: SkillResult;
  error?: string;
  shadow?: boolean;
  cached?: boolean;
}> {
  if (!SKILL_FLAGS.customerEmailInsights()) {
    return { error: 'Skill 未启用' };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const allowed = await canAccessOrderSkill(supabase, orderId);
  if (!allowed) return { error: '无权访问此订单的 AI Skill' };

  try {
    const output = await runSkill(customerEmailInsightsSkill, { orderId }, { triggeredBy: 'user' });
    if (output.circuitBroken) {
      return { error: 'Skill 已熔断，请稍后重试' };
    }
    return {
      result: output.displayResult || undefined,
      shadow: output.displayResult === null && output.internalResult !== null,
      cached: output.cacheHit,
    };
  } catch (err: any) {
    console.error('[runCustomerEmailInsights] outer error:', err?.message);
    return { error: 'Skill 运行异常' };
  }
}

/**
 * 跑「交期可行性分析」Skill
 */
export async function runDeliveryFeasibility(orderId: string): Promise<{
  result?: SkillResult;
  error?: string;
  shadow?: boolean;
  cached?: boolean;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const allowed = await canAccessOrderSkill(supabase, orderId);
  if (!allowed) return { error: '无权访问此订单的 AI Skill' };

  try {
    const output = await runSkill(deliveryFeasibilitySkill, { orderId }, { triggeredBy: 'user' });
    if (output.circuitBroken) return { error: 'Skill 已熔断' };
    return {
      result: output.displayResult || undefined,
      shadow: output.displayResult === null && output.internalResult !== null,
      cached: output.cacheHit,
    };
  } catch (err: any) {
    return { error: 'Skill 运行异常' };
  }
}

/**
 * 失效订单缓存 — 订单数据变更后调用
 * 内部使用，不对外暴露
 */
export async function invalidateSkillCache(orderId: string): Promise<void> {
  await invalidateOrderSkillCache(orderId);
}
