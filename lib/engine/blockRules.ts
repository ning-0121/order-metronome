/**
 * 确认链阻塞规则 — 哪个确认模块阻塞哪些 milestone
 *
 * severity:
 *   - 'hard' — 系统强制阻止，必须确认后才能推进
 *   - 'warn' — 允许推进但显示警告
 */

export interface BlockRule {
  confirmation_type: string;
  blocks_milestones: string[];
  severity: 'hard' | 'warn';
  block_reason: string;
}

export const CONFIRMATION_BLOCK_RULES: BlockRule[] = [
  // ═══ 面料与颜色 ═══
  {
    confirmation_type: 'fabric_color',
    blocks_milestones: ['procurement_order_placed'],
    severity: 'hard',
    block_reason: '面料颜色未确认，不允许采购大货面料',
  },
  {
    confirmation_type: 'fabric_color',
    blocks_milestones: ['production_kickoff'],
    severity: 'hard',
    block_reason: '面料颜色未确认，不允许开裁',
  },

  // ═══ 尺码配比 ═══
  {
    confirmation_type: 'size_breakdown',
    blocks_milestones: ['production_kickoff'],
    severity: 'hard',
    block_reason: '尺码配比未确认，不允许开裁',
  },
  {
    confirmation_type: 'size_breakdown',
    blocks_milestones: ['production_order_upload'],
    severity: 'hard',
    block_reason: '尺码配比未确认，不允许下生产单',
  },
  {
    confirmation_type: 'size_breakdown',
    blocks_milestones: ['packing_method_confirmed'],
    severity: 'warn',
    block_reason: '尺码配比未确认，包装数量可能有误',
  },

  // ═══ Logo/印花/绣花 ═══
  {
    confirmation_type: 'logo_print',
    blocks_milestones: ['production_kickoff'],
    severity: 'hard',
    block_reason: 'Logo/印花文件未确认，不允许进入生产',
  },

  // ═══ 包装/唛头/标签 ═══
  {
    confirmation_type: 'packaging_label',
    blocks_milestones: ['packing_method_confirmed'],
    severity: 'hard',
    block_reason: '包装要求未确认，不允许采购包装材料',
  },
  {
    confirmation_type: 'packaging_label',
    blocks_milestones: ['booking_done'],
    severity: 'hard',
    block_reason: '唛头/标签未确认，不允许订舱',
  },
  {
    confirmation_type: 'packaging_label',
    blocks_milestones: ['shipment_execute'],
    severity: 'hard',
    block_reason: '包装未确认，不允许出货',
  },
];

/** 付款相关的 milestone 阻塞规则 */
export const PAYMENT_BLOCK_RULES = [
  {
    condition: 'deposit_not_received',
    blocks_milestones: ['production_kickoff'],
    severity: 'hard' as const,
    block_reason: '定金未收，不允许开始生产',
  },
  {
    condition: 'payment_hold',
    blocks_milestones: ['production_kickoff', 'booking_done', 'shipment_execute'],
    severity: 'hard' as const,
    block_reason: '付款问题暂停，不允许继续推进',
  },
  {
    condition: 'balance_not_received',
    blocks_milestones: ['shipment_execute'],
    severity: 'hard' as const,
    block_reason: '尾款未收，不允许出货',
  },
];

/**
 * 计算某个 milestone 被哪些规则阻塞
 */
export function getBlockedReasons(
  stepKey: string,
  confirmations: Array<{ module: string; status: string }>,
  financials: { deposit_status: string; balance_status: string; payment_hold: boolean; allow_production: boolean; allow_shipment: boolean } | null,
  incoterm?: string,
): { blocked: boolean; hardBlocks: string[]; warnings: string[] } {
  // 国内单（非 DDP）跳过出运相关的包装阻塞
  const isDomestic = incoterm && incoterm !== 'DDP';
  const DOMESTIC_SKIP_MILESTONES = ['booking_done', 'shipment_execute'];
  const hardBlocks: string[] = [];
  const warnings: string[] = [];

  // 确认链规则（仅当订单有确认链记录时才检查，老订单跳过）
  if (confirmations.length > 0) {
    for (const rule of CONFIRMATION_BLOCK_RULES) {
      if (!rule.blocks_milestones.includes(stepKey)) continue;
      // 国内单跳过出运相关的包装阻塞（国内不走订舱/出运）
      if (isDomestic && DOMESTIC_SKIP_MILESTONES.includes(stepKey) && rule.confirmation_type === 'packaging_label') continue;
      const conf = confirmations.find(c => c.module === rule.confirmation_type);
      if (!conf || conf.status !== 'confirmed') {
        if (rule.severity === 'hard') hardBlocks.push(rule.block_reason);
        else warnings.push(rule.block_reason);
      }
    }
  }

  // 付款规则
  // TODO(SoT): payment collection status is owned by Finance System.
  // deposit_status / balance_status are legacy/cache signals only and must not
  // be treated as the source of truth. When OM's order_financials is stale,
  // these blocks may fail to trigger (false negative) or block unnecessarily
  // (false positive). allow_production / allow_shipment / payment_hold are
  // OM-side override controls — those remain valid. See docs/system-layer.md.
  if (financials) {
    // Admin override 检查
    const productionOverridden = financials.allow_production;
    const shipmentOverridden = financials.allow_shipment;

    for (const rule of PAYMENT_BLOCK_RULES) {
      if (!rule.blocks_milestones.includes(stepKey)) continue;

      let triggered = false;
      if (rule.condition === 'deposit_not_received' && financials.deposit_status !== 'received') triggered = true;
      if (rule.condition === 'payment_hold' && financials.payment_hold) triggered = true;
      if (rule.condition === 'balance_not_received' && financials.balance_status !== 'received') triggered = true;

      if (!triggered) continue;

      // 检查 override
      if (rule.condition === 'deposit_not_received' && productionOverridden) continue;
      if (rule.condition === 'balance_not_received' && shipmentOverridden) continue;

      hardBlocks.push(rule.block_reason);
    }
  }

  return {
    blocked: hardBlocks.length > 0,
    hardBlocks,
    warnings,
  };
}
