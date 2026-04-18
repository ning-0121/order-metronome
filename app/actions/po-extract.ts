'use server';

/**
 * PO 智能提取引擎 — Document Intelligence Layer
 *
 * 核心原则：一次提取，多次复用
 *   上传 PO/采购单/截图后触发一次 Claude Vision 解析，
 *   结果写入 document_extractions 表，后续：
 *     - 订单创建预填充     → getOrderExtraction()
 *     - PO 合规比对        → getOrderExtraction()
 *     - PI/CI/PL 生成      → getOrderExtraction()
 *   均从缓存读取，不重复消耗 token。
 *
 * 支持格式：PDF / JPG / PNG / WEBP（含微信截图/邮件截图/正式PO）
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

// ── 标准化 PO 提取 JSON 结构 ──────────────────────────────────────
export interface POLineItem {
  line_no: number;
  style_no: string;
  description: string;
  color: string;
  sizes: Record<string, number>;      // e.g. {"XS":10,"S":20,"M":30}
  total_quantity: number;
  unit: string;
  delivery_date: string | null;
  notes: string | null;
}

export interface POPackagingRequirements {
  carton_spec: string | null;        // 外箱规格
  hangtag: string | null;            // 吊牌要求
  barcode: string | null;            // 条形码/扫描码
  polybag: string | null;            // 胶袋
  hanger: string | null;             // 衣架
  inner_packing: string | null;      // 内包装
  label: string | null;              // 贴标/唛头
  assortment: string | null;         // 配色配码
}

export interface ExtractedPO {
  header: {
    po_number: string | null;
    issue_date: string | null;
    delivery_date: string | null;
    incoterm: string | null;
    currency: string | null;
    ship_to: string | null;
    customer_name: string | null;
  };
  line_items: POLineItem[];
  total_quantity: number;
  packaging_requirements: POPackagingRequirements;
  production_notes: string[];         // 生产注意事项
  quality_requirements: string[];     // 品质要求
  special_instructions: string | null;
  extraction_meta: {
    confidence: number;
    uncertain_fields: string[];
    source_language: string;
  };
}

// ── 主提取函数 ─────────────────────────────────────────────────────

/**
 * 从已上传的附件中提取 PO 信息（支持 PDF / 图片）
 *
 * @param attachmentId  order_attachments.id
 * @param orderId       所属订单 ID
 * @param sourceType    文件类型（影响提示词）
 */
export async function extractPOFromAttachment(
  attachmentId: string,
  orderId: string,
  sourceType: 'pdf' | 'image_po' | 'screenshot_wechat' | 'screenshot_email' = 'image_po',
): Promise<{ data?: { extractionId: string; extracted: ExtractedPO }; error?: string }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: '请先登录' };

    // 检查是否已有 confirmed 或 modified 的提取结果（复用缓存）
    const { data: existing } = await (supabase.from('document_extractions') as any)
      .select('id, extracted_json, review_status')
      .eq('attachment_id', attachmentId)
      .in('review_status', ['confirmed', 'modified'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing?.extracted_json) {
      return {
        data: {
          extractionId: existing.id,
          extracted: existing.extracted_json as ExtractedPO,
        },
      };
    }

    // 获取附件信息
    const { data: attachment } = await (supabase.from('order_attachments') as any)
      .select('file_name, storage_path, mime_type, file_url')
      .eq('id', attachmentId)
      .single();
    if (!attachment) return { error: '附件不存在' };

    // 从 Supabase Storage 下载文件
    const storagePath = attachment.storage_path;
    if (!storagePath) return { error: '附件存储路径不存在，请重新上传' };

    const { data: fileBlob, error: downloadError } = await supabase.storage
      .from('order-attachments')
      .download(storagePath);
    if (downloadError || !fileBlob) return { error: `文件下载失败：${downloadError?.message}` };

    const arrayBuffer = await fileBlob.arrayBuffer();
    const base64Data = Buffer.from(arrayBuffer).toString('base64');
    const mimeType = (attachment.mime_type || 'image/jpeg') as string;

    // 调用 Claude Vision 提取
    const startTime = Date.now();
    const { callClaudeJSON } = await import('@/lib/agent/anthropicClient');

    const systemPrompt = `你是专业的服装外贸单据解析引擎。你的任务是从上传的文件中精确提取 Purchase Order（PO）信息。

**提取规则：**
1. 只提取文件中明确存在的信息，不猜测或补全
2. 日期统一格式 YYYY-MM-DD；数量只取纯数字
3. 尺码表提取所有出现的码段（XS/S/M/L/XL/XXL/0X/1X/2X/3X等）
4. 包装要求、生产注意事项、品质要求分类提取，原文保留，不缩减
5. 中英文混合内容均需识别
6. 如果某字段不存在或不确定，在 uncertain_fields 中列出
7. 不提取价格相关信息（unit_price、total_price 等）`;

    const extractionPrompt = `请从这份${getSourceTypeLabel(sourceType)}中提取所有 PO 信息。

严格按以下 JSON 结构返回，不要 markdown 包装：
{
  "header": {
    "po_number": "PO号（如无则null）",
    "issue_date": "发单日期YYYY-MM-DD（如无则null）",
    "delivery_date": "交货日期YYYY-MM-DD（如无则null）",
    "incoterm": "贸易条款如FOB/DDP（如无则null）",
    "currency": "货币如USD/EUR（默认USD）",
    "ship_to": "收货地址/港口（如无则null）",
    "customer_name": "客户名称（如无则null）"
  },
  "line_items": [
    {
      "line_no": 行号整数,
      "style_no": "款号",
      "description": "款式描述",
      "color": "颜色",
      "sizes": {"S":数量,"M":数量,"L":数量},
      "total_quantity": 该款合计数量整数,
      "unit": "单位如PCS",
      "delivery_date": "该款交期YYYY-MM-DD或null",
      "notes": "该款备注或null"
    }
  ],
  "total_quantity": 所有款式合计总数量整数,
  "packaging_requirements": {
    "carton_spec": "外箱规格或null",
    "hangtag": "吊牌要求或null",
    "barcode": "条形码要求或null",
    "polybag": "胶袋要求或null",
    "hanger": "衣架要求或null",
    "inner_packing": "内包装要求或null",
    "label": "贴标/唛头要求或null",
    "assortment": "配色配码说明或null"
  },
  "production_notes": ["生产注意事项1","生产注意事项2"],
  "quality_requirements": ["品质要求1","品质要求2"],
  "special_instructions": "其他特殊说明文字或null",
  "extraction_meta": {
    "confidence": 0.0到1.0的置信度,
    "uncertain_fields": ["不确定的字段名"],
    "source_language": "en或zh或mixed"
  }
}`;

    let extracted: ExtractedPO | null = null;
    let extractionTokens = 0;
    let extractError: string | null = null;

    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic();

      // 根据 MIME 类型选择消息格式
      const isPDF = mimeType === 'application/pdf';
      const imageMediaType = (mimeType.startsWith('image/') ? mimeType : 'image/jpeg') as
        'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

      const contentBlock = isPDF
        ? {
            type: 'document' as const,
            source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: base64Data },
          }
        : {
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: imageMediaType, data: base64Data },
          };

      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            contentBlock as any,
            { type: 'text', text: extractionPrompt },
          ],
        }],
      });

      extractionTokens = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
      const rawText = response.content[0].type === 'text' ? response.content[0].text : '';

      // 清理 JSON
      let jsonStr = rawText.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      extracted = JSON.parse(jsonStr) as ExtractedPO;
    } catch (err: any) {
      extractError = err?.message || 'AI提取失败';
    }

    // 写入数据库
    const { data: extractionRecord, error: insertError } = await (supabase.from('document_extractions') as any)
      .insert({
        order_id: orderId,
        attachment_id: attachmentId,
        source_type: sourceType,
        file_name: attachment.file_name,
        doc_category: 'customer_po',
        extracted_json: extracted,
        confidence_score: extracted?.extraction_meta?.confidence ?? null,
        uncertain_fields: extracted?.extraction_meta?.uncertain_fields ?? [],
        extraction_model: 'claude-sonnet-4-20250514',
        extraction_tokens: extractionTokens,
        extracted_at: new Date().toISOString(),
        extract_error: extractError,
        review_status: extracted ? 'pending_review' : 'rejected',
        created_by: user.id,
      })
      .select('id')
      .single();

    if (insertError) return { error: `保存提取结果失败：${insertError.message}` };
    if (!extracted) return { error: `AI提取失败：${extractError}` };

    revalidatePath(`/orders/${orderId}`);
    return {
      data: {
        extractionId: extractionRecord.id,
        extracted,
      },
    };
  } catch (err: any) {
    return { error: err?.message || '提取失败，请稍后重试' };
  }
}

/**
 * 获取订单的 PO 提取结果（已确认的，用于各模块复用）
 * 优先级：modified > confirmed > pending_review
 */
export async function getOrderExtraction(
  orderId: string,
  docCategory: string = 'customer_po',
): Promise<ExtractedPO | null> {
  try {
    const supabase = await createClient();

    const { data } = await (supabase.from('document_extractions') as any)
      .select('extracted_json, review_status')
      .eq('order_id', orderId)
      .eq('doc_category', docCategory)
      .not('extracted_json', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return data?.extracted_json as ExtractedPO | null;
  } catch {
    return null;
  }
}

/**
 * 业务确认/修改提取结果
 * 确认后，该提取数据可用于订单创建、PI/CI生成等
 */
export async function confirmExtraction(
  extractionId: string,
  modifiedJson?: ExtractedPO,   // 如果业务有修改，传入修改后的数据
  reviewNotes?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: '请先登录' };

    const updateData: any = {
      review_status: modifiedJson ? 'modified' : 'confirmed',
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
      review_notes: reviewNotes || null,
      updated_at: new Date().toISOString(),
    };
    if (modifiedJson) {
      updateData.extracted_json = modifiedJson;
    }

    const { error } = await (supabase.from('document_extractions') as any)
      .update(updateData)
      .eq('id', extractionId);

    if (error) return { ok: false, error: error.message };

    // 获取 order_id 用于路径更新
    const { data: extraction } = await (supabase.from('document_extractions') as any)
      .select('order_id').eq('id', extractionId).single();
    if (extraction?.order_id) revalidatePath(`/orders/${extraction.order_id}`);

    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message };
  }
}

/**
 * 从 PO 提取结果生成采购共享表格（自动拆分为物料行）
 * 生产单 → 每个 line_item 的面料/辅料各成一行
 */
export async function createProcurementSheetFromExtraction(
  orderId: string,
  extractionId: string,
): Promise<{ data?: { sheetId: string }; error?: string }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: '请先登录' };

    // 获取订单信息
    const { data: order } = await (supabase.from('orders') as any)
      .select('order_no, customer_name').eq('id', orderId).single();
    if (!order) return { error: '订单不存在' };

    // 获取提取数据
    const { data: extraction } = await (supabase.from('document_extractions') as any)
      .select('extracted_json').eq('id', extractionId).single();
    const po = extraction?.extracted_json as ExtractedPO | null;

    // 生成表格编号
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const sheetNo = `PS-${order.order_no}`;
    const title = `${order.order_no}【${order.customer_name}】采购进程表`;

    // 创建表头
    const { data: sheet, error: sheetError } = await (supabase.from('procurement_shared_sheets') as any)
      .insert({
        order_id: orderId,
        sheet_no: sheetNo,
        title,
        status: 'active',
        extraction_id: extractionId,
        created_by: user.id,
      })
      .select('id')
      .single();
    if (sheetError) return { error: sheetError.message };

    // 自动生成采购明细行（来自 PO line_items）
    const items: any[] = [];
    if (po?.line_items && po.line_items.length > 0) {
      po.line_items.forEach((item, idx) => {
        // 主面料行（每款一行）
        items.push({
          sheet_id: sheet.id,
          order_id: orderId,
          row_no: (idx + 1) * 10,       // 10, 20, 30... 留插行空间
          material_name: '面料',
          material_code: item.style_no,
          specification: `${item.color || '—'} | ${item.description || '—'}`,
          unit: 'M',
          quantity: null,                // 采购自行填写用量
          required_date: item.delivery_date
            ? new Date(new Date(item.delivery_date).getTime() - 15 * 86400000).toISOString().slice(0, 10)
            : null,  // 交货前15天需到货
          arrival_status: 'pending',
          procurement_notes: item.notes || null,
        });
      });

      // 包装辅料行（来自 packaging_requirements）
      const pkg = po.packaging_requirements;
      let rowBase = (po.line_items.length + 1) * 10;
      if (pkg?.hangtag) {
        items.push({
          sheet_id: sheet.id, order_id: orderId,
          row_no: rowBase++, material_name: '吊牌',
          specification: pkg.hangtag, unit: 'PCS',
          arrival_status: 'pending',
        });
      }
      if (pkg?.barcode) {
        items.push({
          sheet_id: sheet.id, order_id: orderId,
          row_no: rowBase++, material_name: '条码贴',
          specification: pkg.barcode, unit: 'PCS',
          arrival_status: 'pending',
        });
      }
      if (pkg?.polybag) {
        items.push({
          sheet_id: sheet.id, order_id: orderId,
          row_no: rowBase++, material_name: '胶袋',
          specification: pkg.polybag, unit: 'PCS',
          arrival_status: 'pending',
        });
      }
      if (pkg?.label) {
        items.push({
          sheet_id: sheet.id, order_id: orderId,
          row_no: rowBase++, material_name: '洗标/唛头',
          specification: pkg.label, unit: 'PCS',
          arrival_status: 'pending',
        });
      }
    } else {
      // 没有 PO 数据时，创建空模板行
      for (let i = 1; i <= 3; i++) {
        items.push({
          sheet_id: sheet.id, order_id: orderId,
          row_no: i * 10, material_name: '',
          unit: 'M', arrival_status: 'pending',
        });
      }
    }

    if (items.length > 0) {
      await (supabase.from('procurement_sheet_items') as any).insert(items);
    }

    revalidatePath(`/orders/${orderId}`);
    return { data: { sheetId: sheet.id } };
  } catch (err: any) {
    return { error: err?.message };
  }
}

/**
 * 获取订单的采购共享表格（含明细行）
 */
export async function getProcurementSheet(orderId: string) {
  try {
    const supabase = await createClient();
    const { data: sheet } = await (supabase.from('procurement_shared_sheets') as any)
      .select('*')
      .eq('order_id', orderId)
      .neq('status', 'archived')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!sheet) return { data: null };

    const { data: items } = await (supabase.from('procurement_sheet_items') as any)
      .select('*')
      .eq('sheet_id', sheet.id)
      .order('row_no');

    return { data: { sheet, items: items || [] } };
  } catch {
    return { data: null };
  }
}

/**
 * 更新采购明细行（任意角色可更新对应字段）
 */
export async function updateProcurementItem(
  itemId: string,
  updates: Partial<{
    material_name: string;
    specification: string;
    quantity: number;
    unit_price: number;
    supplier: string;
    required_date: string;
    order_placed_date: string;
    expected_arrival: string;
    actual_arrival: string;
    arrival_qty: number;
    arrival_status: string;
    procurement_notes: string;
    qc_notes: string;
    warehouse_notes: string;
    sales_notes: string;
  }>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: '请先登录' };

    const { error } = await (supabase.from('procurement_sheet_items') as any)
      .update({ ...updates, last_updated_by: user.id, last_updated_at: new Date().toISOString() })
      .eq('id', itemId);

    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message };
  }
}

// ── 工具函数 ──────────────────────────────────────────────────────

function getSourceTypeLabel(sourceType: string): string {
  const labels: Record<string, string> = {
    pdf: 'PDF文件',
    image_po: '图片格式PO',
    screenshot_wechat: '微信截图',
    screenshot_email: '邮件截图',
    email_body: '邮件正文',
    manual: '手动录入',
  };
  return labels[sourceType] || '文件';
}
