/**
 * Gate Generator - 动态生成 Gate 时间表
 * 
 * 职责：
 * 1. 根据订单特征筛选应该生成的 Gate
 * 2. 计算每个 Gate 的 planned_at 和 due_at
 * 3. 处理 Gate 依赖关系
 */

import {
  GATE_TEMPLATES,
  shouldGenerateGate,
  adjustGateOffset,
  resolveDependsOn,
  type GateTemplate,
  type OrderType,
  type PackagingType,
} from '@/lib/domain/gates';
import { subtractWorkingDays, ensureBusinessDay } from './date';

export interface GateSchedule {
  gate_key: string;
  name_cn: string;
  stage: string;
  owner_role: string;
  required: boolean;
  depends_on: string[];
  planned_at: Date;
  due_at: Date;
  is_critical: boolean;
  evidence_required: boolean;
  initial_status: 'pending' | 'in_progress';
}

export interface OrderParams {
  createdAt: Date;
  incoterm: 'FOB' | 'DDP';
  order_type: OrderType;
  packaging_type: PackagingType;
  order_purpose?: string;
  needs_pp_sample?: boolean;
  needs_ship_sample?: boolean;
  needs_qc?: boolean;
  etd?: string | null;
  warehouse_due_date?: string | null;
}

