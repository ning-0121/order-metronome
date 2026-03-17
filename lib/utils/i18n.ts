/**
 * 外贸行业专用措辞规范
 * 
 * 替换原则：
 * 里程碑 → 执行节点 / 控制节点
 * 控制点 → 执行节点
 * 阻塞 → 卡单 / 风险上报
 * 完成 → 放行 / 结案（视节点类型）
 * 延期 → 顺延 / 延期申请
 */

export function getRoleLabel(role: string): string {
  const map: Record<string, string> = {
    sales: '业务',
    finance: '财务',
    procurement: '采购',
    production: '生产',
    qc: 'QC',
    logistics: '货运/物流',
    admin: '管理员',
  };
  return map[role?.toLowerCase()] ?? role ?? '—';
}

export function getStatusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: '待执行',
    in_progress: '执行中',
    done: '已完成',
    blocked: '卡单',
    overdue: '超期未结',
    // 兼容中文旧值
    '未开始': '待执行',
    '进行中': '执行中',
    '已完成': '已完成',
    '卡住': '卡单',
    '超期': '超期未结',
  };
  return map[status] ?? status ?? '—';
}

export function getOrderTypeLabel(type: string): string {
  const map: Record<string, string> = {
    sample: '样品单',
    bulk: '大货单',
    repeat: '翻单',
  };
  return map[type] ?? type ?? '—';
}

export function getIncotermLabel(incoterm: string): string {
  const map: Record<string, string> = {
    FOB: 'FOB（船上交货）',
    DDP: 'DDP（完税后交货）',
  };
  return map[incoterm] ?? incoterm ?? '—';
}

export function getFileTypeLabel(fileType: string): string {
  const map: Record<string, string> = {
    customer_po: '客户PO',
    production_order: '生产制单',
    trims_sheet: '辅料表',
    packing_requirement: '装箱要求',
    tech_pack: '工艺单（Tech Pack）',
  };
  return map[fileType] ?? fileType ?? '—';
}

export function getExceptionTypeLabel(type: string): string {
  const map: Record<string, string> = {
    quality: 'QC质量异常',
    material_delay: '物料延误',
    production_delay: '生产延期',
    shipment: '出货异常',
    customer_change: '客户改单',
    qty_variance: '数量差异',
    cost_overrun: '成本超支',
    supplier: '供应商异常',
    other: '其他',
  };
  return map[type] ?? type ?? '—';
}
