/**
 * Skill 3 — 报价审核（V2：自动识别文件内容）
 *
 * 从订单附件中智能匹配：
 *   1. 内部成本核算单（Excel/PDF）→ 解析成本数据
 *   2. 客户报价单 → 解析报价
 *   3. 客户PO → 解析确认价格
 *
 * 用 Claude AI 解析文件内容，计算单件利润，比对报价与PO是否一致。
 * 如果有 order_cost_baseline 数据则优先使用（更准确）。
 */

import type {
  SkillModule,
  SkillInput,
  SkillResult,
  SkillFinding,
  SkillContext,
} from './types';

// 文件匹配规则：模糊匹配文件名或 file_type
const FILE_PATTERNS: Record<string, { fileTypes: string[]; namePatterns: RegExp[] }> = {
  cost_sheet: {
    fileTypes: ['internal_quote', 'cost_sheet', 'cost_baseline'],
    namePatterns: [/成本/i, /核算/i, /cost/i, /内部.*报价/i, /内部.*核算/i, /costing/i],
  },
  customer_quote: {
    fileTypes: ['customer_quote', 'quote', 'quotation'],
    namePatterns: [/客户.*报价/i, /报价单/i, /quote/i, /quotation/i, /PI/i, /proforma/i],
  },
  customer_po: {
    fileTypes: ['customer_po', 'po'],
    namePatterns: [/PO/i, /purchase.*order/i, /订单确认/i, /order.*confirm/i],
  },
};

function findAttachment(attachments: any[], category: string): any | null {
  const patterns = FILE_PATTERNS[category];
  if (!patterns) return null;

  // 优先匹配 file_type
  for (const ft of patterns.fileTypes) {
    const match = attachments.find((a: any) => a.file_type === ft);
    if (match) return match;
  }
  // 其次模糊匹配文件名
  for (const regex of patterns.namePatterns) {
    const match = attachments.find((a: any) => regex.test(a.file_name || ''));
    if (match) return match;
  }
  return null;
}

async function downloadFileAsBase64(supabase: any, attachment: any): Promise<{ base64: string; mimeType: string } | null> {
  try {
    // 优先用 storage_path 下载
    const storagePath = attachment.storage_path
      || attachment.file_url?.replace(/^.*\/order-docs\//, '');
    if (!storagePath) return null;

    const { data: blob, error } = await supabase.storage
      .from('order-docs')
      .download(storagePath);
    if (error || !blob) return null;

    const arrayBuf = await blob.arrayBuffer();
    const base64 = Buffer.from(arrayBuf).toString('base64');
    const mimeType = attachment.mime_type || 'application/octet-stream';
    return { base64, mimeType };
  } catch {
    return null;
  }
}

async function extractFinancialData(
  base64: string,
  mimeType: string,
  fileName: string,
  docType: string,
): Promise<{
  unit_price?: number;
  total_amount?: number;
  quantity?: number;
  currency?: string;
  cost_per_piece?: number;
  fabric_cost?: number;
  processing_fee?: number;
  other_cost?: number;
  raw_text?: string;
} | null> {
  try {
    const { callClaudeJSON } = await import('@/lib/agent/anthropicClient');

    // 构建 content blocks
    const contentBlocks: any[] = [];

    // PDF 用 document 类型，图片用 image 类型
    if (mimeType === 'application/pdf') {
      contentBlocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64 },
      });
    } else if (mimeType.startsWith('image/')) {
      contentBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: base64 },
      });
    } else {
      // Excel/其他格式：尝试当作文本读取
      const textContent = Buffer.from(base64, 'base64').toString('utf-8').slice(0, 5000);
      if (textContent.includes('\0') || textContent.length < 10) {
        // 二进制文件（如xlsx），无法直接解析，跳过
        return null;
      }
      contentBlocks.push({ type: 'text', text: `文件内容（${fileName}）：\n${textContent}` });
    }

    const prompt = docType === 'cost_sheet'
      ? `这是一份服装订单的内部成本核算单。请提取以下数据（如有）：
- cost_per_piece: 单件总成本（人民币）
- fabric_cost: 面料成本（人民币/件）
- processing_fee: 加工费（人民币/件）
- other_cost: 其他成本（人民币/件）
- unit_price: 对外报价（如有）
- currency: 货币
- quantity: 数量

只返回 JSON，找不到的字段不要包含。`
      : `这是一份服装订单的${docType === 'customer_po' ? '客户PO（采购订单）' : '客户报价单'}。请提取：
- unit_price: 单价
- total_amount: 总金额
- quantity: 数量
- currency: 货币（USD/RMB/EUR等）

只返回 JSON，找不到的字段不要包含。`;

    contentBlocks.push({ type: 'text', text: prompt });

    const result = await callClaudeJSON<any>({
      scene: 'quote-review-extract',
      model: 'claude-sonnet-4-20250514',
      maxTokens: 1024,
      timeoutMs: 60_000,
      system: '你是一个专业的服装外贸财务助手。从文件中提取财务数据，严格返回JSON格式。',
      messages: [{ role: 'user', content: contentBlocks }],
    });

    return result;
  } catch (e: any) {
    console.error('[quoteReview] extractFinancialData error:', e?.message);
    return null;
  }
}

export const quoteReviewSkill: SkillModule = {
  name: 'quote_review',
  displayName: '报价审核',
  cacheTtlMs: 60 * 60 * 1000,

  hashInput: (input: SkillInput) =>
    JSON.stringify({ orderId: input.orderId, version: 'v3-file-aware' }),

  async run(input: SkillInput, ctx: SkillContext): Promise<SkillResult> {
    if (!input.orderId) throw new Error('需要 orderId');

    // 读取订单
    const { data: order } = await (ctx.supabase.from('orders') as any)
      .select('id, order_no, customer_name, quantity, incoterm')
      .eq('id', input.orderId)
      .single();
    if (!order) throw new Error('订单不存在');

    // 读取已有的成本基线
    const { data: baseline } = await (ctx.supabase.from('order_cost_baseline') as any)
      .select('*')
      .eq('order_id', input.orderId)
      .single();

    // 读取订单附件
    const { data: allAttachments } = await (ctx.supabase.from('order_attachments') as any)
      .select('id, file_name, file_type, file_url, storage_path, mime_type')
      .eq('order_id', input.orderId);
    const attachments = allAttachments || [];

    const findings: SkillFinding[] = [];

    // ── 步骤1：查找文件 ──
    const costFile = findAttachment(attachments, 'cost_sheet');
    const quoteFile = findAttachment(attachments, 'customer_quote');
    const poFile = findAttachment(attachments, 'customer_po');

    const foundFiles: string[] = [];
    if (costFile) foundFiles.push(`内部成本核算单: ${costFile.file_name}`);
    if (quoteFile) foundFiles.push(`客户报价单: ${quoteFile.file_name}`);
    if (poFile) foundFiles.push(`客户PO: ${poFile.file_name}`);

    // ── 步骤2：如果有成本基线，直接用（已解析的结构化数据更准确） ──
    if (baseline && baseline.total_cost_per_piece > 0) {
      return runBaselineAnalysis(order, baseline, findings, foundFiles);
    }

    // ── 步骤3：没有基线，尝试从文件提取 ──
    if (!costFile && !quoteFile && !poFile) {
      return {
        severity: 'low',
        summary: '⚠ 未找到可分析的财务文件',
        findings: [{
          category: '数据缺失',
          severity: 'medium',
          label: '未找到内部成本核算单、客户报价单或客户PO',
          detail: '请在订单资料中上传相关文件（支持 PDF、图片格式），系统会自动识别并解析内容',
        }],
        suggestions: [{ action: '上传内部成本核算单和客户PO', reason: '需要文件才能审核利润率' }],
        confidence: 0,
        source: 'rules',
      };
    }

    // 提取文件数据
    let costData: any = null;
    let quoteData: any = null;
    let poData: any = null;

    if (costFile) {
      const file = await downloadFileAsBase64(ctx.supabase, costFile);
      if (file) {
        costData = await extractFinancialData(file.base64, file.mimeType, costFile.file_name, 'cost_sheet');
        if (costData) {
          findings.push({
            category: '文件识别',
            severity: 'low',
            label: `✅ 已解析内部成本核算单: ${costFile.file_name}`,
            detail: costData.cost_per_piece
              ? `单件成本 ¥${costData.cost_per_piece}（面料 ¥${costData.fabric_cost || '?'} + 加工 ¥${costData.processing_fee || '?'}）`
              : '已读取文件，部分数据需人工确认',
          });
        }
      }
    }

    if (poFile) {
      const file = await downloadFileAsBase64(ctx.supabase, poFile);
      if (file) {
        poData = await extractFinancialData(file.base64, file.mimeType, poFile.file_name, 'customer_po');
        if (poData) {
          findings.push({
            category: '文件识别',
            severity: 'low',
            label: `✅ 已解析客户PO: ${poFile.file_name}`,
            detail: poData.unit_price
              ? `PO单价 ${poData.currency || '$'}${poData.unit_price}，数量 ${poData.quantity || order.quantity || '?'}`
              : '已读取文件，部分数据需人工确认',
          });
        }
      }
    }

    if (quoteFile) {
      const file = await downloadFileAsBase64(ctx.supabase, quoteFile);
      if (file) {
        quoteData = await extractFinancialData(file.base64, file.mimeType, quoteFile.file_name, 'customer_quote');
        if (quoteData) {
          findings.push({
            category: '文件识别',
            severity: 'low',
            label: `✅ 已解析客户报价单: ${quoteFile.file_name}`,
            detail: quoteData.unit_price
              ? `报价单价 ${quoteData.currency || '$'}${quoteData.unit_price}`
              : '已读取文件',
          });
        }
      }
    }

    // ── 步骤4：利润计算 ──
    const costPerPiece = costData?.cost_per_piece || 0;
    const sellingPrice = poData?.unit_price || quoteData?.unit_price || 0;
    const currency = poData?.currency || quoteData?.currency || 'USD';
    const exchangeRate = currency === 'RMB' || currency === 'CNY' ? 1 : 7.2;
    const sellingPriceRmb = sellingPrice * exchangeRate;

    if (costPerPiece > 0 && sellingPrice > 0) {
      const profitPerPiece = sellingPriceRmb - costPerPiece;
      const profitRate = (profitPerPiece / sellingPriceRmb * 100);
      const totalProfit = profitPerPiece * (order.quantity || 0);

      let severity: 'high' | 'medium' | 'low' = 'low';
      if (profitRate < 8) {
        severity = 'high';
        findings.push({
          category: '利润率',
          severity: 'high',
          label: `🔴 利润率 ${profitRate.toFixed(1)}% — 严重偏低（低于8%底线）`,
          detail: `成本 ¥${costPerPiece}/件 vs 售价 ${currency}${sellingPrice}（≈¥${sellingPriceRmb.toFixed(2)}），利润 ¥${profitPerPiece.toFixed(2)}/件`,
        });
      } else if (profitRate < 15) {
        severity = 'medium';
        findings.push({
          category: '利润率',
          severity: 'medium',
          label: `🟡 利润率 ${profitRate.toFixed(1)}% — 偏低但可接受`,
          detail: `利润 ¥${profitPerPiece.toFixed(2)}/件，总利润 ¥${totalProfit.toFixed(0)}`,
        });
      } else {
        findings.push({
          category: '利润率',
          severity: 'low',
          label: `🟢 利润率 ${profitRate.toFixed(1)}% — 健康`,
          detail: `利润 ¥${profitPerPiece.toFixed(2)}/件，总利润 ¥${totalProfit.toFixed(0)}`,
        });
      }

      // 成本构成
      if (costData?.fabric_cost && costData?.processing_fee) {
        findings.push({
          category: '成本构成',
          severity: 'low',
          label: `面料 ¥${costData.fabric_cost} + 加工 ¥${costData.processing_fee} + 其他 ¥${(costPerPiece - costData.fabric_cost - costData.processing_fee).toFixed(2)}`,
        });
      }

      // 报价 vs PO 价格一致性
      if (poData?.unit_price && quoteData?.unit_price) {
        const diff = Math.abs(poData.unit_price - quoteData.unit_price);
        if (diff > 0.01) {
          findings.push({
            category: '价格一致性',
            severity: 'high',
            label: `⚠ PO 单价（${currency}${poData.unit_price}）与报价单（${currency}${quoteData.unit_price}）不一致！`,
            detail: `差异 ${currency}${diff.toFixed(2)} — 请确认是否客户谈判后调价`,
          });
          severity = 'high';
        } else {
          findings.push({
            category: '价格一致性',
            severity: 'low',
            label: `✅ PO 单价与报价单一致: ${currency}${poData.unit_price}`,
          });
        }
      }

      return {
        severity,
        summary: profitRate < 8
          ? `🔴 利润率 ${profitRate.toFixed(1)}% 严重偏低`
          : profitRate < 15
            ? `🟡 利润率 ${profitRate.toFixed(1)}%`
            : `🟢 利润率 ${profitRate.toFixed(1)}%`,
        findings,
        suggestions: profitRate < 15
          ? [{ action: `利润率 ${profitRate.toFixed(1)}%，建议和客户沟通提价或优化成本`, reason: '利润空间不足' }]
          : [],
        confidence: 70,
        source: 'ai',
        meta: { costPerPiece, sellingPrice, sellingPriceRmb, profitRate },
      };
    }

    // 只解析到部分数据
    return {
      severity: 'medium',
      summary: '已识别文件但数据不完整，需要人工补充',
      findings,
      suggestions: [
        { action: '请确认文件内容是否完整，或在成本控制Tab手动录入', reason: 'AI解析可能遗漏部分数据' },
      ],
      confidence: 40,
      source: 'ai',
    };
  },
};

// 使用已有 baseline 的分析（原有逻辑）
function runBaselineAnalysis(
  order: any,
  baseline: any,
  findings: SkillFinding[],
  foundFiles: string[],
): SkillResult {
  const costPerPiece = baseline.total_cost_per_piece || 0;
  const sellingPrice = order.incoterm === 'DDP'
    ? (baseline.ddp_price || 0)
    : (baseline.fob_price || 0);
  const exchangeRate = baseline.exchange_rate || 7.2;
  const sellingPriceRmb = sellingPrice * exchangeRate;

  if (sellingPrice === 0 && costPerPiece > 0) {
    return {
      severity: 'medium',
      summary: '⚠ 客户报价未录入，无法计算利润率',
      findings: [{
        category: '数据缺失',
        severity: 'medium',
        label: `成本 ¥${costPerPiece.toFixed(2)}/件，但 ${order.incoterm} 报价为 0`,
        detail: '请在成本基线中录入客户报价',
      }],
      suggestions: [],
      confidence: 30,
      source: 'rules',
    };
  }

  const profitPerPiece = sellingPriceRmb - costPerPiece;
  const profitRate = sellingPriceRmb > 0
    ? Number(((profitPerPiece / sellingPriceRmb) * 100).toFixed(1))
    : 0;
  const totalProfit = profitPerPiece * (order.quantity || 0);

  let severity: 'high' | 'medium' | 'low' = 'low';
  if (profitRate < 8) {
    severity = 'high';
    findings.push({
      category: '利润率',
      severity: 'high',
      label: `🔴 利润率 ${profitRate}% — 严重偏低`,
      detail: `成本 ¥${costPerPiece.toFixed(2)}/件，售价 $${sellingPrice}（≈¥${sellingPriceRmb.toFixed(2)}），利润 ¥${profitPerPiece.toFixed(2)}/件`,
    });
  } else if (profitRate < 15) {
    severity = 'medium';
    findings.push({
      category: '利润率',
      severity: 'medium',
      label: `🟡 利润率 ${profitRate}% — 偏低但可接受`,
      detail: `利润 ¥${profitPerPiece.toFixed(2)}/件，总利润 ¥${totalProfit.toFixed(0)}`,
    });
  } else {
    findings.push({
      category: '利润率',
      severity: 'low',
      label: `🟢 利润率 ${profitRate}% — 健康`,
      detail: `利润 ¥${profitPerPiece.toFixed(2)}/件，总利润 ¥${totalProfit.toFixed(0)}`,
    });
  }

  // 成本构成
  const fabricCost = (baseline.fabric_consumption_kg || 0) * (baseline.fabric_price_per_kg || 0);
  const cmtCost = baseline.cmt_factory_quote || baseline.cmt_internal_estimate || 0;
  if (costPerPiece > 0) {
    findings.push({
      category: '成本构成',
      severity: 'low',
      label: `面料 ${(fabricCost / costPerPiece * 100).toFixed(0)}% + 加工 ${(cmtCost / costPerPiece * 100).toFixed(0)}%`,
      detail: `面料 ¥${fabricCost.toFixed(2)} + 加工 ¥${cmtCost.toFixed(2)}`,
    });
  }

  if (foundFiles.length > 0) {
    findings.push({
      category: '已识别文件',
      severity: 'low',
      label: `📎 ${foundFiles.join('，')}`,
    });
  }

  return {
    severity,
    summary: profitRate < 8
      ? `🔴 利润率 ${profitRate}% 严重偏低`
      : profitRate < 15
        ? `🟡 利润率 ${profitRate}%`
        : `🟢 利润率 ${profitRate}%`,
    findings,
    suggestions: profitRate < 15
      ? [{ action: `利润率 ${profitRate}%，建议和客户沟通提价或优化成本`, reason: '利润空间不足' }]
      : [],
    confidence: 90,
    source: 'rules',
    meta: { costPerPiece, sellingPrice, sellingPriceRmb, profitPerPiece, profitRate, totalProfit },
  };
}
