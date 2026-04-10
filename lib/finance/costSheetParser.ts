/**
 * 内部成本核算单解析器
 *
 * 从"成本核算单-内部审核版.xlsx"中提取关键成本数据。
 * 按表头关键词定位列（兼容不同客户的核算单模板差异）。
 *
 * 提取字段：
 *   - style: 款号 (STYLE)
 *   - fabric_area_m2: 单件用量（平方）
 *   - fabric_weight_kg_m2: 克重 (KG/m²)
 *   - fabric_consumption_kg: 单件用量（公斤） = 平方 × 克重
 *   - fabric_price_per_kg: 净布价（不含税）
 *   - cmt_price: 加工价（内部确认的加工费）
 *   - labor_rate: 工价（工人工价）
 *   - factory_cmt_quote: 增富找加工厂报价
 *   - total_cost: 成本（总成本 RMB）
 *   - fob_price: FOB 报价
 *   - ddp_price: DDP 报价
 *   - fabric_name: 面料名
 *   - fabric_factory: 面料工厂
 *   - notes: 备注
 */

export interface CostSheetRow {
  style: string;
  fabric_composition?: string;
  fob_price?: number;
  ddp_price?: number;
  notes?: string;
  total_cost?: number;
  // 加工费
  cmt_price?: number;          // 内部确认加工费
  labor_rate?: number;         // 工人工价
  factory_cmt_quote?: number;  // 工厂实际报价
  // 面料
  fabric_name?: string;
  fabric_factory?: string;
  fabric_price_per_kg?: number;
  fabric_weight_kg_m2?: number; // 克重 (KG/m²)
  fabric_area_m2?: number;     // 单件用量（平方）
  fabric_consumption_kg?: number; // 单件用量（公斤）
}

export interface CostSheetParseResult {
  rows: CostSheetRow[];
  headerRow: number;
  columnMap: Record<string, number>;
  warnings: string[];
}

// 表头关键词 → 字段映射
const HEADER_PATTERNS: Array<{
  field: keyof CostSheetRow;
  keywords: string[];
  type: 'string' | 'number';
}> = [
  { field: 'style', keywords: ['STYLE', 'style', '款号'], type: 'string' },
  { field: 'fabric_composition', keywords: ['FABRIC COMPOSITION', '面料成分'], type: 'string' },
  { field: 'fob_price', keywords: ['FOB'], type: 'number' },
  { field: 'ddp_price', keywords: ['DDP'], type: 'number' },
  { field: 'notes', keywords: ['备注'], type: 'string' },
  { field: 'total_cost', keywords: ['成本'], type: 'number' },
  { field: 'cmt_price', keywords: ['加工价'], type: 'number' },
  { field: 'labor_rate', keywords: ['工价'], type: 'number' },
  { field: 'factory_cmt_quote', keywords: ['加工厂报价', '增富找'], type: 'number' },
  { field: 'fabric_name', keywords: ['面料A', '面料名'], type: 'string' },
  { field: 'fabric_factory', keywords: ['面料工厂'], type: 'string' },
  { field: 'fabric_price_per_kg', keywords: ['净布价'], type: 'number' },
  { field: 'fabric_weight_kg_m2', keywords: ['克重'], type: 'number' },
  { field: 'fabric_area_m2', keywords: ['单件用量（平方）', '单件用量(平方)'], type: 'number' },
  { field: 'fabric_consumption_kg', keywords: ['单件用量（公斤）', '单件用量(公斤)'], type: 'number' },
];

/**
 * 解析 Excel Buffer → CostSheetRow[]
 */
export async function parseCostSheet(buffer: Buffer): Promise<CostSheetParseResult> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const warnings: string[] = [];

  // 1. 找表头行（包含"单件用量"或"加工价"或"STYLE"关键词的行）
  let headerRow = -1;
  for (let r = 0; r < Math.min(15, data.length); r++) {
    const rowStr = data[r].map(v => String(v)).join(' ');
    if (
      rowStr.includes('单件用量') ||
      rowStr.includes('加工价') ||
      (rowStr.includes('STYLE') && rowStr.includes('克重'))
    ) {
      headerRow = r;
      break;
    }
  }
  if (headerRow < 0) {
    // 兜底：找包含"STYLE"的行
    for (let r = 0; r < Math.min(10, data.length); r++) {
      if (data[r].some(v => String(v).trim() === 'STYLE')) {
        headerRow = r;
        break;
      }
    }
  }
  if (headerRow < 0) {
    warnings.push('找不到表头行（缺少"单件用量"/"加工价"/"STYLE"关键词）');
    return { rows: [], headerRow: -1, columnMap: {}, warnings };
  }

  // 2. 按表头关键词匹配列号
  const headerCells = data[headerRow].map(v => String(v).trim());
  const columnMap: Record<string, number> = {};

  for (const pattern of HEADER_PATTERNS) {
    for (let c = 0; c < headerCells.length; c++) {
      const cell = headerCells[c];
      if (pattern.keywords.some(kw => cell.includes(kw))) {
        columnMap[pattern.field] = c;
        break;
      }
    }
  }

  // 检查关键列是否找到
  const criticalFields = ['fabric_area_m2', 'cmt_price'];
  for (const f of criticalFields) {
    if (columnMap[f] === undefined) {
      warnings.push(`关键列未找到：${f}（可能是表头名称不同）`);
    }
  }

  // 3. 解析数据行
  const rows: CostSheetRow[] = [];
  for (let r = headerRow + 1; r < data.length; r++) {
    const rowData = data[r];
    if (!rowData || rowData.every(v => !v && v !== 0)) continue; // 跳过空行

    const row: CostSheetRow = { style: '' };

    for (const pattern of HEADER_PATTERNS) {
      const colIdx = columnMap[pattern.field];
      if (colIdx === undefined) continue;

      const rawVal = rowData[colIdx];
      if (rawVal === '' || rawVal === null || rawVal === undefined) continue;

      if (pattern.type === 'number') {
        const num = parseFloat(String(rawVal));
        if (!isNaN(num)) (row as any)[pattern.field] = num;
      } else {
        (row as any)[pattern.field] = String(rawVal).trim();
      }
    }

    // 跳过没有任何有意义数据的行
    if (!row.style && !row.fabric_area_m2 && !row.cmt_price && !row.total_cost) continue;

    // 自动计算 fabric_consumption_kg（如果表里没有但有 平方 和 克重）
    if (!row.fabric_consumption_kg && row.fabric_area_m2 && row.fabric_weight_kg_m2) {
      row.fabric_consumption_kg = Number((row.fabric_area_m2 * row.fabric_weight_kg_m2).toFixed(4));
    }

    // CEO 2026-04-09：当"增富找加工厂报价"和"加工价"同时存在时，
    // 用"增富找加工厂报价"（工厂实际报的），因为那是真实付给工厂的价格。
    // "加工价"是内部确认价（可能经过谈判压低了），对账时以工厂实际报价为准。
    if (row.factory_cmt_quote && row.factory_cmt_quote > 0) {
      row.cmt_price = row.factory_cmt_quote;
    }

    rows.push(row);
  }

  return { rows, headerRow, columnMap, warnings };
}

/**
 * 计算原辅料预算（基于内部成本核算单单耗 + 订单数量）
 *
 * @param consumptionKg - 单件用量（KG/件）
 * @param quantity - 订单数量（件）
 * @param wastePct - 损耗率（CEO 定 3%）
 */
export function calculateMaterialBudget(
  consumptionKg: number,
  quantity: number,
  wastePct: number = 3,
): {
  netUsage: number;      // 净用量 KG
  grossUsage: number;    // 含损耗用量 KG
  wastePct: number;
} {
  const netUsage = consumptionKg * quantity;
  const grossUsage = netUsage * (1 + wastePct / 100);
  return {
    netUsage: Number(netUsage.toFixed(2)),
    grossUsage: Number(grossUsage.toFixed(2)),
    wastePct,
  };
}

/**
 * 判断采购数量是否合理
 *
 * @param budgetKg - 预算用量（含损耗）
 * @param orderedKg - 采购下单数量
 * @returns { status, deviationPct }
 */
export function checkProcurementReasonability(
  budgetKg: number,
  orderedKg: number,
): {
  status: 'ok' | 'warning' | 'over_limit';
  deviationPct: number;
  message: string;
} {
  if (budgetKg <= 0) return { status: 'ok', deviationPct: 0, message: '无预算数据' };
  const deviationPct = Number((((orderedKg - budgetKg) / budgetKg) * 100).toFixed(1));

  if (deviationPct > 5) {
    return {
      status: 'over_limit',
      deviationPct,
      message: `🔴 采购超出预算 ${deviationPct}%（超 5% 红线）— 需 CEO 审批`,
    };
  }
  if (deviationPct > 0) {
    return {
      status: 'warning',
      deviationPct,
      message: `🟡 采购略超预算 ${deviationPct}%（在 5% 以内）`,
    };
  }
  if (deviationPct < -10) {
    return {
      status: 'warning',
      deviationPct,
      message: `🟡 采购低于预算 ${Math.abs(deviationPct)}%（可能面料不够）`,
    };
  }
  return {
    status: 'ok',
    deviationPct,
    message: `✅ 采购数量合理（偏差 ${deviationPct}%）`,
  };
}

/**
 * 加工费合理性验证
 *
 * @param internalEstimate - 内部成本核算单的加工费
 * @param factoryQuote - 工厂实际报价
 */
export function checkCmtReasonability(
  internalEstimate: number,
  factoryQuote: number,
): {
  status: 'ok' | 'warning' | 'over_limit';
  deviationPct: number;
  message: string;
} {
  if (internalEstimate <= 0) return { status: 'ok', deviationPct: 0, message: '无内部估价' };
  const deviationPct = Number((((factoryQuote - internalEstimate) / internalEstimate) * 100).toFixed(1));

  if (deviationPct > 10) {
    return {
      status: 'over_limit',
      deviationPct,
      message: `🔴 工厂报价高于内部估价 ${deviationPct}%（利润被压缩）`,
    };
  }
  if (deviationPct > 0) {
    return {
      status: 'warning',
      deviationPct,
      message: `🟡 工厂报价略高 ${deviationPct}%`,
    };
  }
  if (deviationPct < -20) {
    return {
      status: 'warning',
      deviationPct,
      message: `🟡 工厂报价低于内部估价 ${Math.abs(deviationPct)}%（注意品质风险）`,
    };
  }
  return {
    status: 'ok',
    deviationPct,
    message: `✅ 加工费合理（偏差 ${deviationPct}%）`,
  };
}
