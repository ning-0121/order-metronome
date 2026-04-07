'use server';

import Anthropic from '@anthropic-ai/sdk';

export interface POVerifyResult {
  /** 文件类型自检：是否真的是客户 PO */
  document_type?: 'customer_po' | 'quotation' | 'invoice' | 'packing_list' | 'tech_pack' | 'sample_card' | 'other' | 'unknown';
  /** AI 对"是否为有效 PO"的置信度 0-100 */
  confidence?: number;
  /** 文件类型校验未通过时的警告 */
  document_type_warning?: string;
  po_quantity?: number;
  po_delivery_date?: string;
  po_customer?: string;
  po_style_no?: string;
  po_po_number?: string;
  differences: {
    field: string;
    fieldLabel: string;
    poValue: string;
    orderValue: string;
    severity: 'error' | 'warning';
  }[];
  risks: {
    type: string;
    label: string;
    detail: string;
    severity: 'high' | 'medium';
  }[];
  matched: string[];
  special_terms: string[];
  raw_extracted: Record<string, string>;
}

const VERIFY_PROMPT = `你是一个资深外贸服装订单风险分析专家。

【第一步 — 文件类型校验】
首先你必须判断这个文件**是不是客户 PO**。常见的非 PO 文件包括：
- quotation: 报价单（有 "Quote/Quotation/报价"，无明确订单数量承诺）
- invoice: 发票（有 "Invoice/INV"，是已发货后的账单）
- packing_list: 装箱单（有 "Packing List"，列箱号尺寸）
- tech_pack: 工艺单/技术包（有详细的尺寸表、工艺说明，无订单数量/交期）
- sample_card: 样品卡/色卡
- other: 其他无法识别的文档

判断规则：
- 真正的 PO 必须包含：客户公司名 + PO号 + 数量 + 交期 三项中的至少 2 项
- 关键词：Purchase Order / PO Number / Order # / 采购订单 / 订购单
- 如果只有报价没有订单承诺 → quotation
- 如果只有尺寸表没有数量 → tech_pack

【第二步 — 提取关键信息并返回 JSON】
返回严格的 JSON（不要 markdown 包裹）：

{
  "document_type": "customer_po" | "quotation" | "invoice" | "packing_list" | "tech_pack" | "sample_card" | "other",
  "confidence": 0-100 的整数（你对 document_type 判断的把握，以及 PO 字段提取的整体置信度）,
  "document_type_warning": 如果不是 customer_po，给出一句中文警告说明这看起来不是 PO，否则为 null,
  "quantity": 总数量（数字，不要单位）,
  "delivery_date": "交期/到仓日/ETD（YYYY-MM-DD格式）",
  "customer_name": "客户名称",
  "style_no": "款号",
  "po_number": "PO号",
  "order_date": "下单日期（YYYY-MM-DD格式）",
  "risks": [
    { "type": "light_color", "label": "浅色风险", "detail": "白色/米色面料，注意色牢度" }
  ],
  "special_terms": ["客户特殊要求1", "客户特殊要求2"]
}

风险规则：
- light_color：白/米/浅灰/浅粉/奶油等浅色 → 色牢度风险
- color_clash：深浅色拼接（黑白、深蓝+浅色）→ 撞色沾色
- special_wash：特殊洗水/水洗/砂洗/酵素洗 → 工艺风险
- tight_deadline：交期 ≤ 30 天 → 交期紧张
- special_packing：非标准包装 → 包装风险

special_terms：提取生产/出货特殊条款（验货标准、罚款条款、测试要求等）

字段找不到填 null，risks 和 special_terms 没有就填空数组。
**置信度评分**：document_type 明确 + 关键字段都能提取 → 80-100；只能提取部分字段 → 50-80；非 PO 文件或几乎无法提取 → 0-50。`;

/**
 * 从已上传的 PO 附件中提取关键信息，与订单数据比对
 */
export async function verifyPOAgainstOrder(
  fileBase64: string,
  fileType: string,
  fileName: string,
  orderData: {
    quantity?: number | null;
    delivery_date?: string | null;
    customer_name?: string | null;
    style_no?: string | null;
    po_number?: string | null;
    order_no?: string;
  }
): Promise<{ data?: POVerifyResult; error?: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: 'AI 服务未配置' };

  try {
    const client = new Anthropic({ apiKey });
    let messages: Anthropic.MessageParam[];

    if (fileType.startsWith('image/') || fileName.match(/\.(jpg|jpeg|png|webp)$/i)) {
      const mediaType = fileType.startsWith('image/') ? fileType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' : 'image/jpeg';
      messages = [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: fileBase64 } },
          { type: 'text', text: '请从这个PO中提取关键信息。' }
        ]
      }];
    } else if (fileName.match(/\.pdf$/i)) {
      messages = [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } },
          { type: 'text', text: '请从这个PO中提取关键信息。' }
        ]
      }];
    } else if (fileName.match(/\.(xlsx|xls|xlsm)$/i)) {
      // Excel PO 支持：用 exceljs 解析为文本表格，再交给 Claude 提取
      const sheetText = await extractExcelToText(fileBase64);
      if (!sheetText) return { error: 'Excel 文件解析失败，请确认文件未损坏' };
      messages = [{
        role: 'user',
        content: [
          { type: 'text', text: `这是一个 Excel 格式的客户 PO。下面是各 sheet 的内容（已转为文本表格），请提取关键信息：\n\n${sheetText.slice(0, 30000)}` },
        ]
      }];
    } else {
      return { error: '暂只支持 PDF / 图片 / Excel 格式的 PO 比对' };
    }

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: VERIFY_PROMPT,
      messages,
    });

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => (block as Anthropic.TextBlock).text)
      .join('');

    let jsonStr = text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    let extracted: any;
    try {
      extracted = JSON.parse(jsonStr);
    } catch (parseErr: any) {
      return { error: `AI 返回的数据格式异常，请重试。(${parseErr.message})` };
    }
    const differences: POVerifyResult['differences'] = [];
    const matched: string[] = [];

    // ── 文件类型自检：如果不是 customer_po 或置信度太低，立即作为 error 抛出 ──
    const docType = extracted.document_type || 'unknown';
    const confidence = typeof extracted.confidence === 'number' ? extracted.confidence : null;
    let docTypeWarning: string | undefined;
    if (docType !== 'customer_po') {
      const typeLabel: Record<string, string> = {
        quotation: '报价单',
        invoice: '发票',
        packing_list: '装箱单',
        tech_pack: '工艺单/技术包',
        sample_card: '样品卡',
        other: '其他文档',
        unknown: '无法识别',
      };
      docTypeWarning =
        extracted.document_type_warning ||
        `⚠️ AI 判断这不是客户 PO，看起来是「${typeLabel[docType] || docType}」。请确认上传的文件正确。`;
      // 把它作为最高优先级的差异加入列表，强制业务关注
      differences.push({
        field: 'document_type',
        fieldLabel: '文件类型',
        poValue: typeLabel[docType] || docType,
        orderValue: '客户 PO',
        severity: 'error',
      });
    } else if (confidence !== null && confidence < 60) {
      docTypeWarning = `⚠️ AI 提取置信度较低（${confidence}/100），请人工核对所有字段。`;
      differences.push({
        field: 'confidence',
        fieldLabel: '提取置信度',
        poValue: `${confidence}/100`,
        orderValue: '≥ 60',
        severity: 'warning',
      });
    }

    // 比对数量
    if (extracted.quantity != null && orderData.quantity != null) {
      if (Number(extracted.quantity) !== Number(orderData.quantity)) {
        differences.push({
          field: 'quantity',
          fieldLabel: '订单数量',
          poValue: `${extracted.quantity} 件`,
          orderValue: `${orderData.quantity} 件`,
          severity: 'error',
        });
      } else {
        matched.push('订单数量一致');
      }
    }

    // 比对交期
    if (extracted.delivery_date && orderData.delivery_date) {
      const poDate = extracted.delivery_date.replace(/\./g, '-').slice(0, 10);
      const orderDate = orderData.delivery_date.slice(0, 10);
      if (poDate !== orderDate) {
        differences.push({
          field: 'delivery_date',
          fieldLabel: '交期/ETA',
          poValue: poDate,
          orderValue: orderDate,
          severity: 'error',
        });
      } else {
        matched.push('交期一致');
      }
    }

    // 比对客户名
    if (extracted.customer_name && orderData.customer_name) {
      const poCustomer = extracted.customer_name.toLowerCase().trim();
      const orderCustomer = orderData.customer_name.toLowerCase().trim();
      if (!poCustomer.includes(orderCustomer) && !orderCustomer.includes(poCustomer)) {
        differences.push({
          field: 'customer_name',
          fieldLabel: '客户名称',
          poValue: extracted.customer_name,
          orderValue: orderData.customer_name,
          severity: 'warning',
        });
      } else {
        matched.push('客户名一致');
      }
    }

    // 比对PO号
    if (extracted.po_number && orderData.po_number) {
      if (extracted.po_number.trim() !== orderData.po_number.trim()) {
        differences.push({
          field: 'po_number',
          fieldLabel: 'PO号',
          poValue: extracted.po_number,
          orderValue: orderData.po_number,
          severity: 'warning',
        });
      } else {
        matched.push('PO号一致');
      }
    }

    // 风险和特殊条款
    const risks: POVerifyResult['risks'] = (extracted.risks || []).map((r: any) => ({
      type: r.type || 'other',
      label: r.label || '风险提示',
      detail: r.detail || '',
      severity: r.type === 'light_color' || r.type === 'color_clash' || r.type === 'tight_deadline' ? 'high' as const : 'medium' as const,
    }));

    const special_terms: string[] = (extracted.special_terms || []).filter(Boolean);

    return {
      data: {
        document_type: docType,
        confidence: confidence ?? undefined,
        document_type_warning: docTypeWarning,
        po_quantity: extracted.quantity,
        po_delivery_date: extracted.delivery_date,
        po_customer: extracted.customer_name,
        po_style_no: extracted.style_no,
        po_po_number: extracted.po_number,
        differences,
        risks,
        matched,
        special_terms,
        raw_extracted: extracted,
      },
    };
  } catch (err: any) {
    return { error: `比对失败：${err.message}` };
  }
}

/**
 * 把 Excel 文件转成文本表格（每个 sheet 用 markdown 格式呈现）
 * 让 Claude 可以直接读懂内容并提取 PO 字段
 */
async function extractExcelToText(base64: string): Promise<string | null> {
  try {
    const ExcelJS = (await import('exceljs')).default;
    const buffer = Buffer.from(base64, 'base64');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);

    const parts: string[] = [];
    for (const ws of wb.worksheets) {
      // 跳过空 sheet
      if (ws.rowCount === 0) continue;
      parts.push(`## Sheet: ${ws.name}`);
      const rows: string[] = [];
      ws.eachRow({ includeEmpty: false }, (row) => {
        const cells: string[] = [];
        row.eachCell({ includeEmpty: true }, (cell) => {
          let v = cell.value;
          if (v == null) { cells.push(''); return; }
          if (typeof v === 'object') {
            // 富文本/公式/日期等
            if ((v as any).text) v = (v as any).text;
            else if ((v as any).result != null) v = (v as any).result;
            else if (v instanceof Date) v = v.toISOString().slice(0, 10);
            else if ((v as any).richText) v = (v as any).richText.map((r: any) => r.text).join('');
            else v = JSON.stringify(v);
          }
          cells.push(String(v).replace(/\|/g, '\\|').slice(0, 200));
        });
        // 只保留有内容的行
        if (cells.some(c => c.trim())) rows.push('| ' + cells.join(' | ') + ' |');
      });
      if (rows.length === 0) continue;
      parts.push(rows.slice(0, 200).join('\n')); // 每个 sheet 最多 200 行，防 prompt 爆炸
      parts.push('');
    }
    return parts.join('\n');
  } catch (err: any) {
    console.error('[po-verify] Excel parse error:', err?.message);
    return null;
  }
}

// ══════════════════════════════════════════════
// 三单比对：内部报价单 vs 客户报价单 vs 客户PO
// ══════════════════════════════════════════════

export interface ThreeDocVerifyResult {
  summary: string;
  differences: {
    field: string;
    internalValue: string;
    customerQuoteValue: string;
    poValue: string;
    severity: 'error' | 'warning';
    note: string;
  }[];
  risks: string[];
  allMatch: boolean;
  /** 价格是否一致 — 三单价格全部对齐时为 true */
  priceMatch: boolean;
  /** 价格相关差异（从 differences 中筛选出来，便于 UI 优先展示） */
  priceDiffs: {
    field: string;
    internalValue: string;
    customerQuoteValue: string;
    poValue: string;
    note: string;
  }[];
}

/**
 * 三单比对：用 Claude 同时分析内部报价单、客户报价单、客户PO
 * 找出款号、价格、数量、交期、工艺等差异
 */
export async function verifyThreeDocuments(
  files: { type: 'internal_quote' | 'customer_quote' | 'customer_po'; base64: string; fileType: string; fileName: string }[]
): Promise<{ data?: ThreeDocVerifyResult; error?: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: 'AI 服务未配置' };

  if (files.length < 2) return { error: '至少需要2个文件进行比对' };

  try {
    const client = new Anthropic({ apiKey });

    // 构建多文件消息
    const content: Anthropic.ContentBlockParam[] = [];

    const docLabels: Record<string, string> = {
      internal_quote: '内部报价单',
      customer_quote: '客户最终报价单',
      customer_po: '客户PO',
    };

    for (const f of files) {
      content.push({ type: 'text', text: `\n=== ${docLabels[f.type]} (${f.fileName}) ===` });

      if (f.fileType === 'application/pdf') {
        content.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: f.base64 },
        } as any);
      } else if (f.fileType.startsWith('image/')) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: f.fileType as any, data: f.base64 },
        });
      } else {
        content.push({ type: 'text', text: `[文件格式 ${f.fileType} 暂不支持AI分析]` });
      }
    }

    content.push({
      type: 'text',
      text: '\n请比对以上文件，找出差异。',
    });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      system: `你是服装外贸订单审核专家。请比对内部报价单、客户报价单和客户PO这三份文件。

【最高优先级 — 价格一致性】
首先必须严格检查"单价"是否三单一致。这是 CEO 强制的规则：
- 内部报价单的单价 → 必须 = 我们给客户报价单的单价 → 必须 = 客户PO的单价
- 任何币种、单价、起订量价格阶梯不一致 → 严重错误
- 价格不一致的订单不允许创建，必须先和客户对齐 PO

【其他比对维度】
1. 款号/Style Number
2. 数量/Quantity
3. 交期/Delivery Date
4. 颜色/Color
5. 尺码配比/Size Ratio
6. 包装方式/Packing
7. 工艺要求/Craft Requirements
8. 其他特殊条款

返回严格JSON格式（不要 markdown 包裹）：
{
  "summary": "一句话总结比对结果，价格不一致时必须明确说明",
  "priceMatch": true或false,
  "priceDiffs": [
    {"field": "单价/起订量价格阶梯/币种", "internalValue": "...", "customerQuoteValue": "...", "poValue": "...", "note": "差异说明"}
  ],
  "differences": [
    {"field": "字段名", "internalValue": "...", "customerQuoteValue": "...", "poValue": "...", "severity": "error或warning", "note": "风险说明"}
  ],
  "risks": ["风险点1", "风险点2"],
  "allMatch": true或false
}

注意：
- priceDiffs 是 differences 的子集，专门列出价格相关差异
- 如果价格完全一致，priceMatch=true 且 priceDiffs=[]
- 即使价格一致，其他字段不一致仍然要列在 differences 里
- 只返回JSON。`,
      messages: [{ role: 'user', content }],
    });

    const text = response.content.filter(b => b.type === 'text').map(b => (b as Anthropic.TextBlock).text).join('');
    let jsonStr = text.trim();
    if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

    let parsed: any;
    try { parsed = JSON.parse(jsonStr); } catch { return { error: 'AI 返回格式异常，请重试' }; }

    const differences = Array.isArray(parsed.differences) ? parsed.differences : [];
    const priceDiffs = Array.isArray(parsed.priceDiffs)
      ? parsed.priceDiffs
      : differences.filter((d: any) =>
          /价|单价|price|币种|currency|单价阶梯|起订|moq/i.test(d.field || '')
        );

    return {
      data: {
        summary: parsed.summary || '',
        differences,
        risks: Array.isArray(parsed.risks) ? parsed.risks : [],
        allMatch: !!parsed.allMatch,
        priceMatch: parsed.priceMatch != null ? !!parsed.priceMatch : priceDiffs.length === 0,
        priceDiffs,
      },
    };
  } catch (err: any) {
    return { error: `三单比对失败：${err.message}` };
  }
}
