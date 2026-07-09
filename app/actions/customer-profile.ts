'use server';

/**
 * 客户画像 — 历史汇总 + 行为分析
 */

import { createClient } from '@/lib/supabase/server';

export interface CustomerProfile {
  name: string;
  totalOrders: number;
  activeOrders: number;
  completedOrders: number;
  totalQuantity: number;
  totalRevenue: number; // FOB/DDP 报价 × 数量 的累计（概算）
  avgOrderSize: number;
  // 交付表现
  onTimeRate: number;       // 准时交付率
  avgDelayDays: number;     // 平均延期天数
  // 付款习惯
  orderTypes: Record<string, number>; // bulk/repeat/trial 分布
  incoterms: Record<string, number>;  // FOB/DDP/RMB 分布
  // 时间线
  firstOrderDate: string | null;
  lastOrderDate: string | null;
  daysSinceLastOrder: number;
  // 工厂分布
  factories: Array<{ name: string; count: number }>;
  // 风险信号
  riskSignals: string[];
}

