/**
 * AI 调用配额 + 审计 helper
 *
 * 业务背景：parsePO / photo-parser / verifyThreeDocuments 等 server action
 * 直接调 Anthropic API，每次都花钱。如果没鉴权 + 没限速：
 *   - 外部攻击者通过 server action 端点（Next.js 自动生成的 RPC 路由）刷
 *   - 内部员工脚本/误操作循环调用
 *   - 一旦 API 配额超限，所有正常业务的 AI 功能都瘫
 *
 * 设计：
 *   1. 必须先登录 + 邮箱域名校验
 *   2. 写 ai_usage_log（成功/失败/限速都记）
 *   3. 限速规则（per user）：
 *        - 任何 AI api: 60 次 / 小时（最后一小时滑动窗口）
 *        - photo_ocr / production_photo: 30 次 / 小时（图片识别更贵）
 *      超限时返回友好提示，记录 rate_limited 状态
 *
 * 用法：
 *   const guard = await guardAICall('photo_ocr', orderId);
 *   if (!guard.ok) return { ok: false, error: guard.error };
 *   // ... do AI call ...
 *   await logAICall('photo_ocr', orderId, 'success', durationMs);
 */

import { createClient } from '@/lib/supabase/server';

export type AIApi =
  | 'po_parse'
  | 'po_verify'
  | 'three_doc_verify'
  | 'photo_ocr'
  | 'cost_sheet'
  | 'production_photo'
  | 'risk_assessment';

/** 每小时调用上限（per user） */
const HOURLY_LIMIT: Record<AIApi, number> = {
  po_parse:        20,  // 创建订单时偶尔触发
  po_verify:       30,
  three_doc_verify: 20,
  photo_ocr:       30,  // 拍照识别贵
  cost_sheet:      20,
  production_photo: 50, // 日报拍照频率高
  risk_assessment: 60,
};

/** 全 API 加起来的小时上限（防总量刷） */
const TOTAL_HOURLY_LIMIT = 120;

export interface GuardResult {
  ok: boolean;
  userId?: string;
  error?: string;
  /** 当前小时已用 / 上限，用于 UI 友好提示 */
  used?: number;
  limit?: number;
}

/**
 * 调用 AI 之前先 guard：验证登录 + 检查配额
 * 返回 ok=false 时直接 return；ok=true 时拿到 userId 继续
 */
export async function guardAICall(api: AIApi, orderId?: string | null): Promise<GuardResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '请先登录后再使用 AI 功能' };
  if (!user.email?.endsWith('@qimoclothing.com')) {
    return { ok: false, error: '仅允许 @qimoclothing.com 邮箱使用本系统' };
  }

  // 查最近 1 小时调用数（同 api + 全 api）
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const { data: rows, error } = await (supabase.from('ai_usage_log') as any)
    .select('api')
    .eq('user_id', user.id)
    .gte('created_at', hourAgo);

  if (error) {
    // 查询失败不阻塞业务，记日志放行（fail-open）
    console.warn('[ai-rate-limit] usage query failed, fail-open:', error.message);
    return { ok: true, userId: user.id };
  }

  const total = (rows || []).length;
  const apiCount = (rows || []).filter((r: any) => r.api === api).length;
  const apiLimit = HOURLY_LIMIT[api] ?? 30;

  if (total >= TOTAL_HOURLY_LIMIT) {
    await logUsage(user.id, api, orderId, 'rate_limited', 0, `total ${total}/${TOTAL_HOURLY_LIMIT}`);
    return {
      ok: false,
      userId: user.id,
      error: `AI 调用总量已达上限（${total}/${TOTAL_HOURLY_LIMIT} 次/小时）。请稍后再试，或联系管理员调整配额。`,
      used: total,
      limit: TOTAL_HOURLY_LIMIT,
    };
  }
  if (apiCount >= apiLimit) {
    await logUsage(user.id, api, orderId, 'rate_limited', 0, `${api} ${apiCount}/${apiLimit}`);
    return {
      ok: false,
      userId: user.id,
      error: `「${apiLabel(api)}」调用已达上限（${apiCount}/${apiLimit} 次/小时）。请稍后再试。`,
      used: apiCount,
      limit: apiLimit,
    };
  }

  return { ok: true, userId: user.id, used: apiCount, limit: apiLimit };
}

/**
 * 记一次 AI 调用结果（成功 / 失败 / 超时）
 * fire-and-forget — 失败不影响主链路，但会 console.warn
 */
export async function logAICall(
  api: AIApi,
  orderId: string | null | undefined,
  status: 'success' | 'error' | 'timeout',
  durationMs?: number,
  note?: string,
): Promise<void> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return; // 没登录就不记（不会到这里，guardAICall 已经拦了）
    await logUsage(user.id, api, orderId, status, durationMs, note);
  } catch (e: any) {
    console.warn('[ai-rate-limit] logAICall failed:', e?.message);
  }
}

async function logUsage(
  userId: string,
  api: AIApi,
  orderId: string | null | undefined,
  status: 'success' | 'error' | 'rate_limited' | 'timeout',
  durationMs?: number,
  note?: string,
): Promise<void> {
  try {
    const supabase = await createClient();
    await (supabase.from('ai_usage_log') as any).insert({
      user_id: userId,
      api,
      order_id: orderId || null,
      status,
      duration_ms: durationMs ?? null,
      note: note?.slice(0, 500) || null,
    });
  } catch (e: any) {
    console.warn('[ai-rate-limit] logUsage insert failed:', e?.message);
  }
}

function apiLabel(api: AIApi): string {
  const map: Record<AIApi, string> = {
    po_parse: '客户 PO 解析',
    po_verify: 'PO 二次核对',
    three_doc_verify: '三单比对',
    photo_ocr: '拍照识别',
    cost_sheet: '成本核算单解析',
    production_photo: '生产日报照片提取',
    risk_assessment: 'AI 风险评估',
  };
  return map[api] || api;
}
