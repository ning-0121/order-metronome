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
  matched: string[];
  raw_extracted: Record<string, string>;
}

const VERIFY_PROMPT = `你是一个外贸订单核对专家。请从这个客户PO中提取以下关键信息，返回严格的JSON（不要markdown包裹）：

{
  "quantity": 总数量（数字，不要单位），
  "delivery_date": "交期/到仓日/ETD（YYYY-MM-DD格式）",
  "customer_name": "客户名称",
  "style_no": "款号",
  "po_number": "PO号"
}

如果某个字段找不到，填 null。数量必须是纯数字。日期统一为 YYYY-MM-DD。`;

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

    const extracted = JSON.parse(jsonStr);
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

    return {
      data: {
        po_quantity: extracted.quantity,
        po_delivery_date: extracted.delivery_date,
        po_customer: extracted.customer_name,
        po_style_no: extracted.style_no,
        po_po_number: extracted.po_number,
        differences,
        matched,
        raw_extracted: extracted,
      },
    };
  } catch (err: any) {
    return { error: `比对失败：${err.message}` };
  }
}
