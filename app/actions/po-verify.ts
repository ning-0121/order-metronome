'use server';

import Anthropic from '@anthropic-ai/sdk';

export interface POVerifyResult {
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

const VERIFY_PROMPT = `你是一个资深外贸服装订单风险分析专家。请从这个客户PO中提取关键信息并分析风险，返回严格的JSON（不要markdown包裹）：

{
  "quantity": 总数量（数字，不要单位），
  "delivery_date": "交期/到仓日/ETD（YYYY-MM-DD格式）",
  "customer_name": "客户名称",
  "style_no": "款号",
  "po_number": "PO号",
  "order_date": "下单日期（YYYY-MM-DD格式）",
  "risks": [
    {
      "type": "light_color",
      "label": "浅色风险",
      "detail": "具体说明，如：白色/米色面料，注意色牢度"
    }
  ],
  "special_terms": ["客户特殊要求1", "客户特殊要求2"]
}

risks 风险分析规则（请仔细扫描PO内容）：
- light_color：如果颜色为白色、米色、浅灰、浅粉、奶油色等浅色，提示色牢度风险
- color_clash：如果有深浅色拼接（如黑白、深蓝+浅色等），提示撞色沾色风险
- special_wash：如果有特殊洗水/水洗/砂洗/酵素洗要求，提示工艺风险
- tight_deadline：如果交期在30天以内，提示交期紧张
- special_packing：如果有特殊包装要求（不同于标准包装），提示包装风险

special_terms：提取PO中涉及生产和出货的特殊条款/要求（如验货标准、罚款条款、特殊测试要求等）

如果某个字段找不到填 null，risks 和 special_terms 没有就填空数组。`;

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
    } else {
      return { error: '暂只支持 PDF 和图片格式的 PO 比对' };
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
      system: `你是服装外贸订单审核专家。请比对内部报价单、客户报价单和客户PO这三份文件，找出以下维度的差异：
1. 款号/Style Number
2. 单价/Price（注意币种）
3. 数量/Quantity
4. 交期/Delivery Date
5. 颜色/Color
6. 尺码配比/Size Ratio
7. 包装方式/Packing
8. 工艺要求/Craft Requirements
9. 其他特殊条款

返回严格JSON格式：
{
  "summary": "一句话总结比对结果",
  "differences": [
    {"field": "字段名", "internalValue": "内部报价值", "customerQuoteValue": "客户报价值", "poValue": "PO值", "severity": "error或warning", "note": "风险说明"}
  ],
  "risks": ["风险点1", "风险点2"],
  "allMatch": true或false
}
如果三单完全一致，differences为空数组，allMatch为true。只返回JSON。`,
      messages: [{ role: 'user', content }],
    });

    const text = response.content.filter(b => b.type === 'text').map(b => (b as Anthropic.TextBlock).text).join('');
    let jsonStr = text.trim();
    if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

    let parsed: any;
    try { parsed = JSON.parse(jsonStr); } catch { return { error: 'AI 返回格式异常，请重试' }; }

    return {
      data: {
        summary: parsed.summary || '',
        differences: Array.isArray(parsed.differences) ? parsed.differences : [],
        risks: Array.isArray(parsed.risks) ? parsed.risks : [],
        allMatch: !!parsed.allMatch,
      },
    };
  } catch (err: any) {
    return { error: `三单比对失败：${err.message}` };
  }
}
