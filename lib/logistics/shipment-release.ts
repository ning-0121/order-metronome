export type ShipmentGateKey = 'business_execution' | 'qc' | 'logistics' | 'finance' | 'documents' | 'packing';
export type ShipmentGateInput = Record<ShipmentGateKey, { passed: boolean; evidenceId?: string | null }>;
export type ShipmentGateResult = {
  allowed: boolean;
  blockers: Array<{ key: ShipmentGateKey; label: string; responsibleRole: string; nextAction: string; href: string; evidenceId?: string | null }>;
};

const META: Record<ShipmentGateKey, { label: string; responsibleRole: string; nextAction: string; href: string }> = {
  business_execution: { label: '业务执行尚未确认出货准备', responsibleRole: 'merchandiser', nextAction: '确认客户与出货资料', href: '/orders' },
  qc: { label: 'QC 尚未放行', responsibleRole: 'production', nextAction: '完成尾查/复检和放行', href: '/production' },
  logistics: { label: '物流准备未完成', responsibleRole: 'logistics', nextAction: '完成订舱/装箱/出库准备', href: '/logistics' },
  finance: { label: '财务出货条件未满足', responsibleRole: 'finance', nextAction: '由财务处理现有 allow_shipment 条件', href: '/pending-approval' },
  documents: { label: '缺少出货单据', responsibleRole: 'merchandiser', nextAction: '生成并核对装箱/出货单据', href: '/orders' },
  packing: { label: '缺少装箱数据', responsibleRole: 'logistics', nextAction: '补充装箱和批次明细', href: '/logistics' },
};

export function evaluateShipmentGate(input: ShipmentGateInput): ShipmentGateResult {
  const blockers = (Object.keys(META) as ShipmentGateKey[])
    .filter((key) => !input[key].passed)
    .map((key) => ({ key, ...META[key], evidenceId: input[key].evidenceId }));
  return { allowed: blockers.length === 0, blockers };
}
