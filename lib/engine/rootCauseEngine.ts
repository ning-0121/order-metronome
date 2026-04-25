/**
 * Root Cause Engine — 主入口
 *
 * 职责：
 *   - 读取订单上下文（orders / milestones / financials / confirmations）
 *   - 跑所有已注册规则（rules/causeRules）
 *   - 幂等落库到 order_root_causes
 *   - 上次有 active 但本次未触发的 cause → 自动 resolved
 *
 * 当前 Step 1 状态：骨架完成，可被调用但不会写入任何数据
 * （ALL_CAUSE_RULES 为空 + featureFlag 默认关闭）。
 *
 * 调用方约定：
 *   - 仅 Server Actions / Cron / API Route 调用
 *   - 永不在 markMilestoneDone 等主流程内同步触发
 *   - 失败必须 try/catch，不向上抛出
 */

import { rootCauseEngineEnabled } from './featureFlags';
import { ALL_CAUSE_RULES } from './rules/causeRules';
import type {
  OrderContext,
  RootCauseScanResult,
} from './types';

interface ScanOptions {
  source?: 'rule' | 'ai' | 'manual';
  triggerUser?: string;
  /** 测试模式：跑规则但不写库 */
  dryRun?: boolean;
}

/**
 * 扫描单个订单的根因
 *
 * 实现将在 Step 2 完成。当前为骨架：
 *   - flag 关闭：直接返回空结果
 *   - flag 开启但规则注册表为空：返回 0 cause
 */
export async function scanOrder(
  _orderId: string,
  _opts: ScanOptions = {},
): Promise<RootCauseScanResult> {
  // 兜底空结果，永不抛错
  const empty: RootCauseScanResult = {
    newCauses: 0,
    updatedCauses: 0,
    resolvedCauses: 0,
    errors: [],
    rulesEvaluated: 0,
  };

  if (!rootCauseEngineEnabled()) return empty;
  if (ALL_CAUSE_RULES.length === 0) return empty;

  // Step 2 将在此实现：
  // 1) 加载 OrderContext
  // 2) for each rule: try { rule.evaluate(ctx) } catch { errors.push }
  // 3) upsert active causes
  // 4) auto-resolve missing
  // 5) write milestone_logs
  return empty;
}

/**
 * 批量扫描所有活跃订单（cron 入口）
 * Step 2 之前禁用，避免误触发。
 */
export async function scanAllActiveOrders(): Promise<{
  totalOrders: number;
  totalCauses: number;
  errors: string[];
}> {
  if (!rootCauseEngineEnabled()) {
    return { totalOrders: 0, totalCauses: 0, errors: [] };
  }
  return { totalOrders: 0, totalCauses: 0, errors: [] };
}

/**
 * 为引擎构建 OrderContext（暴露给 BusinessDecisionEngine 复用）
 * 当前为占位，Step 2 实现完整加载逻辑。
 */
export async function buildOrderContext(_orderId: string): Promise<OrderContext | null> {
  return null;
}
