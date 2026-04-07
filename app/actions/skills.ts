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
import type { SkillResult } from '@/lib/agent/skills/types';

/**
 * 跑「缺失资料检查」Skill
 *
 * 权限：仅 admin（Phase 1 阶段所有 Skill 都仅 admin 可见）
 * Feature flag：SKILL_MISSING_INFO=true 才生效
 */
export async function runMissingInfoCheck(orderId: string): Promise<{
  result?: SkillResult;
  error?: string;
  shadow?: boolean;
  cached?: boolean;
}> {
  // 1. Feature flag 检查
  if (!SKILL_FLAGS.missingInfo()) {
    return { error: 'Skill 未启用' };
  }

  // 2. 权限：仅 admin
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可访问 AI Skill' };

  // 3. 通过 runner 调度
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
    // runner 内部已经兜底过，这里基本不会触发
    console.error('[runMissingInfoCheck] outer error:', err?.message);
    return { error: 'Skill 运行异常' };
  }
}

/**
 * 跑「风险评估」Skill
 *
 * 12 维度规则评分 + AI 增强（可选）
 * 权限：仅 admin
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
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可访问 AI Skill' };

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
 * 失效订单缓存 — 订单数据变更后调用
 * 内部使用，不对外暴露
 */
export async function invalidateSkillCache(orderId: string): Promise<void> {
  await invalidateOrderSkillCache(orderId);
}
