// ============================================================
// Procurement view — 角色可见性解析（用真实角色 + 真实权限组）
// 锁定规则（用户 2026-06-30）：
//  - procurement / merchandiser / admin / production_manager：可看采购视图（含供应商分组 + 执行明细）
//  - production：物料 readiness + 生产状态（不看供应商分组 / 执行 / 成本）
//  - sales：订单/报价可见，但【不看】供应商级采购分组、不看采购执行
//  - finance：订单摘要 + 金额 + 审批字段；【不看】供应商分组 / 采购执行 / 采购成本
//  - 其它（quality / admin_assistant / logistics）：默认拒绝（admin 全开）
// 真实角色枚举（DB user_role，10 个）：sales finance procurement production quality
//   admin merchandiser production_manager admin_assistant logistics
// ============================================================

import { hasRoleInGroup } from '@/lib/domain/roles';
import type { ProcurementCapabilities } from './types';

function has(roles: string[], ...allow: string[]): boolean {
  return roles.some((r) => allow.includes(r));
}

export function resolveCapabilities(roles: string[]): ProcurementCapabilities {
  const isAdmin = has(roles, 'admin');
  const isProcExec = has(roles, 'procurement', 'merchandiser', 'production_manager');
  const isProduction = has(roles, 'production');
  const isSales = has(roles, 'sales');
  const isFinance = has(roles, 'finance');

  const view = isAdmin || isProcExec || isProduction || isSales || isFinance;

  // 供应商分组 / 执行明细：仅采购执行类角色 + admin（sales/finance/production 不看）
  const supplierGrouping = isAdmin || isProcExec;
  const executionDetail = isAdmin || isProcExec;

  // 采购成本（物料单价/金额）：仅 admin / procurement / production_manager
  //   merchandiser 可看分组与执行量，但不看采购成本；finance/sales/production 不看
  const procurementCost = isAdmin || has(roles, 'procurement', 'production_manager');

  // 订单金额：复用真实 CAN_SEE_FINANCIALS（admin/finance/sales 在内）
  const orderFinancials = hasRoleInGroup(roles, 'CAN_SEE_FINANCIALS');

  // 物料 readiness + 生产状态：任何能看视图的角色都可见
  const productionReadiness = view;

  return { view, supplierGrouping, executionDetail, procurementCost, orderFinancials, productionReadiness };
}
