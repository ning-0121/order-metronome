'use server';

/**
 * 工厂评分 — 交期/质量/配合度三维打分
 *
 * 数据来源全自动（不需要人工评分）：
 *   交期分 = 已完成订单的工厂完成节点准时率
 *   质量分 = 中查/尾查逾期率的反面（越少逾期 = 质量管控越好）
 *   配合度 = 平均响应时间（从节点开始到完成的速度）
 */

import { createClient } from '@/lib/supabase/server';

export interface FactoryScore {
  factoryName: string;
  totalOrders: number;
  activeOrders: number;
  completedOrders: number;
  // 三维评分（0-100）
  deliveryScore: number;    // 交期：工厂完成节点准时率
  qualityScore: number;     // 质量：QC 节点准时率
  cooperationScore: number; // 配合度：平均响应速度
  overallScore: number;     // 综合 = 交期 40% + 质量 35% + 配合 25%
  grade: 'S' | 'A' | 'B' | 'C' | 'D';
  // 明细
  onTimeDeliveryRate: number;
  avgDeliveryDelay: number;
  qcOnTimeRate: number;
  avgResponseDays: number;
  // 在手
  currentLoad: number;
  customers: string[];
}

