'use server';

/**
 * 报价员训练数据管理 — 工价单批量导入
 *
 * 流程：
 *   1. 管理员拖拽上传图片/Excel/PDF → storage
 *   2. 后端自动识别：
 *      - 图片 → Claude Vision 提取工序 + 工价
 *      - Excel → exceljs 解析表格
 *   3. 结果写入 quoter_cmt_training_samples (status=pending_review)
 *   4. 管理员审核：确认 / 修改 / 拒绝
 *   5. 确认后的样本用于 RAG 检索 + 趋势分析
 *
 * 权限：仅 admin / production_manager / admin_assistant
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { callClaudeJSON } from '@/lib/agent/anthropicClient';

// ════════════════════════════════════════════════
// 权限检查
// ════════════════════════════════════════════════

async function checkTrainingAccess(): Promise<{ ok: boolean; userId?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '请先登录' };

  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const userRoles: string[] =
    (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const allowed = userRoles.some((r: string) =>
    ['admin', 'production_manager', 'admin_assistant'].includes(r),
  );
  if (!allowed) return { ok: false, error: '无权限：仅管理员可管理训练数据' };
  return { ok: true, userId: user.id };
}

// ════════════════════════════════════════════════
// 上传文件 → Storage
// ════════════════════════════════════════════════

export async function uploadTrainingFile(
  file: File,
): Promise<{ error?: string; sampleId?: string }> {
  const auth = await checkTrainingAccess();
  if (!auth.ok || !auth.userId) return { error: auth.error };

  const supabase = await createClient();

  // 判断文件类型
  const fileName = file.name.toLowerCase();
  const mime = file.type || '';
  let sourceType: 'image' | 'excel' | 'pdf' | 'manual' = 'manual';
  if (mime.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|heic)$/.test(fileName)) {
    sourceType = 'image';
  } else if (mime.includes('spreadsheet') || /\.(xlsx|xls|csv)$/.test(fileName)) {
    sourceType = 'excel';
  } else if (mime === 'application/pdf' || fileName.endsWith('.pdf')) {
    sourceType = 'pdf';
  } else {
    return { error: `不支持的文件类型：${file.name}（只支持图片/Excel/PDF）` };
  }

  // 上传到 storage
  const ext = fileName.split('.').pop() || 'bin';
  const storagePath = `quoter-training/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const { error: upErr } = await supabase.storage
    .from('order-docs')
    .upload(storagePath, file, { contentType: mime || undefined, upsert: false });
  if (upErr) return { error: `上传失败：${upErr.message}` };

  const { data: { publicUrl } } = supabase.storage.from('order-docs').getPublicUrl(storagePath);

  // 先插入 pending 记录
  const { data: sample, error: insErr } = await (supabase.from('quoter_cmt_training_samples') as any)
    .insert({
      source_type: sourceType,
      source_file_name: file.name,
      source_file_url: publicUrl,
      storage_path: storagePath,
      status: 'pending_review',
      uploaded_by: auth.userId,
    })
    .select('id')
    .single();
  if (insErr) {
    await supabase.storage.from('order-docs').remove([storagePath]);
    return { error: `数据库写入失败：${insErr.message}` };
  }

  // 异步触发提取（不阻塞上传响应）
  // Next.js server action 同步返回，所以我们在这里直接 await
  // 如果想真异步，可以不 await 但错误难追踪
  try {
    if (sourceType === 'image') {
      await extractFromImage((sample as any).id, storagePath, mime);
    } else if (sourceType === 'excel') {
      await extractFromExcel((sample as any).id, storagePath);
    }
  } catch (e: any) {
    console.error('[uploadTrainingFile] extraction error:', e?.message);
    // 不阻断，管理员可以手动编辑
  }

  revalidatePath('/quoter/training');
  return { sampleId: (sample as any).id };
}

// ════════════════════════════════════════════════
// 从图片提取工价单（Claude Vision）
// ════════════════════════════════════════════════

async function extractFromImage(
  sampleId: string,
  storagePath: string,
  mime: string,
): Promise<void> {
  const supabase = await createClient();

  // 下载图片为 base64
  const { data: blob, error: dlErr } = await supabase.storage
    .from('order-docs')
    .download(storagePath);
  if (dlErr || !blob) {
    await (supabase.from('quoter_cmt_training_samples') as any)
      .update({ extraction_error: `下载失败：${dlErr?.message || '未知'}` })
      .eq('id', sampleId);
    return;
  }

  const buf = Buffer.from(await blob.arrayBuffer());
  const base64 = buf.toString('base64');

  // 调 Claude Vision
  const { callClaude } = await import('@/lib/agent/anthropicClient');

  const systemPrompt = `你是一个外贸服装加工费报价单识别专家。给你一张工价单图片（可能是车间手写单、Excel 截图、或打印的工序明细），你需要提取结构化数据。

**输出格式**（严格 JSON，不要 markdown 包装）：
{
  "garment_type": "knit_top|knit_bottom|woven_pants|woven_shorts",
  "garment_subtype": "tshirt|legging|chino 等，不确定留空字符串",
  "style_no": "款号，看不到留空字符串",
  "customer_name": "客户，看不到留空字符串",
  "factory_name": "工厂，看不到留空字符串",
  "total_cmt_rmb": 数字,
  "operations": [
    { "name": "工序名称（中文）", "rate": 数字(RMB) }
  ],
  "raw_text": "你从图片里读到的原文（便于人工校对）",
  "confidence": 0-100
}

**识别规则**：
1. garment_type 必须是 4 个枚举之一
2. 所有价格单位默认 RMB/件，如果看到 USD 要换算（忽略或用 7.2 汇率）
3. operations 列表尽量完整，典型工序有：裁剪/合肩/上领/上袖/合侧缝/下摆/袖口/钉唛/熨烫/修剪线头/QC/包装 等
4. 如果总价和工序明细对不上（差 >20%），confidence 压到 60 以下
5. 如果完全看不清，confidence < 40
6. 车间手写单常见潦草字迹，尽力而为，不清楚的工序用 "?" 占位`;

  const result = await callClaude({
    scene: 'quoter-cmt-extract',
    model: 'claude-sonnet-4-20250514',
    maxTokens: 2500,
    timeoutMs: 45_000,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: (mime || 'image/jpeg') as
                | 'image/jpeg'
                | 'image/png'
                | 'image/gif'
                | 'image/webp',
              data: base64,
            },
          },
          { type: 'text', text: '请识别这张工价单，输出 JSON。' },
        ],
      },
    ],
  });

  if (!result?.text) {
    await (supabase.from('quoter_cmt_training_samples') as any)
      .update({ extraction_error: 'Claude Vision 返回空' })
      .eq('id', sampleId);
    return;
  }

  // 解析 JSON
  let parsed: any = null;
  try {
    let txt = result.text.trim();
    if (txt.startsWith('```')) txt = txt.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    parsed = JSON.parse(txt);
  } catch (e: any) {
    await (supabase.from('quoter_cmt_training_samples') as any)
      .update({
        extraction_error: `JSON 解析失败：${e?.message}`,
        ai_raw_text: result.text.slice(0, 3000),
      })
      .eq('id', sampleId);
    return;
  }

  // 校验 garment_type
  const validTypes = ['knit_top', 'knit_bottom', 'woven_pants', 'woven_shorts'];
  if (parsed.garment_type && !validTypes.includes(parsed.garment_type)) {
    parsed.garment_type = null;
  }

  await (supabase.from('quoter_cmt_training_samples') as any)
    .update({
      garment_type: parsed.garment_type || null,
      garment_subtype: parsed.garment_subtype || null,
      style_no: parsed.style_no || null,
      customer_name: parsed.customer_name || null,
      factory_name: parsed.factory_name || null,
      total_cmt_rmb: parsed.total_cmt_rmb || null,
      operations: parsed.operations || null,
      extraction_method: 'claude_vision',
      ai_confidence: parsed.confidence || null,
      ai_raw_text: parsed.raw_text || null,
      extraction_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', sampleId);
}

// ════════════════════════════════════════════════
// 从 Excel 提取（exceljs）
// ════════════════════════════════════════════════

async function extractFromExcel(sampleId: string, storagePath: string): Promise<void> {
  const supabase = await createClient();

  const { data: blob, error: dlErr } = await supabase.storage
    .from('order-docs')
    .download(storagePath);
  if (dlErr || !blob) {
    await (supabase.from('quoter_cmt_training_samples') as any)
      .update({ extraction_error: `下载失败：${dlErr?.message || '未知'}` })
      .eq('id', sampleId);
    return;
  }

  const buf = Buffer.from(await blob.arrayBuffer());

  try {
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.default.Workbook();
    await wb.xlsx.load(buf as any);

    // 把第一个 sheet 转成文本给 Claude 解析
    const sheet = wb.worksheets[0];
    if (!sheet) throw new Error('Excel 文件没有 sheet');

    const rows: string[] = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
      const values = (row.values as any[])
        .slice(1)
        .map(v => {
          if (v === null || v === undefined) return '';
          if (typeof v === 'object' && 'text' in v) return v.text;
          if (typeof v === 'object' && 'result' in v) return String(v.result);
          return String(v);
        })
        .join('\t');
      rows.push(`行${rowNum}: ${values}`);
    });

    const excelText = rows.slice(0, 100).join('\n'); // 最多前 100 行

    // 让 Claude 解析文本
    const systemPrompt = `你是一个外贸服装加工费报价单解析专家。下面是从 Excel 提取的表格文本（Tab 分隔），请提取结构化数据。

**输出格式**（严格 JSON）：
{
  "garment_type": "knit_top|knit_bottom|woven_pants|woven_shorts",
  "garment_subtype": "tshirt|legging|chino 等",
  "style_no": "款号",
  "customer_name": "客户",
  "factory_name": "工厂",
  "total_cmt_rmb": 数字,
  "operations": [{"name": "工序名称", "rate": 数字}],
  "raw_text": "你识别到的关键文本摘要",
  "confidence": 0-100
}

规则同图片识别。不要 markdown 包装。`;

    const result = await callClaudeJSON<any>({
      scene: 'quoter-cmt-excel-extract',
      model: 'claude-sonnet-4-20250514',
      maxTokens: 2500,
      timeoutMs: 30_000,
      system: systemPrompt,
      prompt: excelText,
    });

    if (!result) {
      await (supabase.from('quoter_cmt_training_samples') as any)
        .update({ extraction_error: 'Claude 解析 Excel 失败', ai_raw_text: excelText.slice(0, 3000) })
        .eq('id', sampleId);
      return;
    }

    const validTypes = ['knit_top', 'knit_bottom', 'woven_pants', 'woven_shorts'];
    if (result.garment_type && !validTypes.includes(result.garment_type)) {
      result.garment_type = null;
    }

    await (supabase.from('quoter_cmt_training_samples') as any)
      .update({
        garment_type: result.garment_type || null,
        garment_subtype: result.garment_subtype || null,
        style_no: result.style_no || null,
        customer_name: result.customer_name || null,
        factory_name: result.factory_name || null,
        total_cmt_rmb: result.total_cmt_rmb || null,
        operations: result.operations || null,
        extraction_method: 'excel_parser',
        ai_confidence: result.confidence || null,
        ai_raw_text: excelText.slice(0, 3000),
        extraction_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', sampleId);
  } catch (e: any) {
    await (supabase.from('quoter_cmt_training_samples') as any)
      .update({ extraction_error: `Excel 解析异常：${e?.message}` })
      .eq('id', sampleId);
  }
}

// ════════════════════════════════════════════════
// 查询 / 审核 / 统计
// ════════════════════════════════════════════════

export async function listTrainingSamples(
  status: 'all' | 'pending_review' | 'confirmed' | 'rejected' | 'needs_edit' = 'pending_review',
  limit = 100,
): Promise<{ data?: any[]; error?: string; counts?: Record<string, number> }> {
  const auth = await checkTrainingAccess();
  if (!auth.ok) return { error: auth.error };

  const supabase = await createClient();

  let query = (supabase.from('quoter_cmt_training_samples') as any)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (status !== 'all') {
    query = query.eq('status', status);
  }

  const { data, error } = await query;
  if (error) return { error: error.message };

  // 各状态计数
  const { data: allRows } = await (supabase.from('quoter_cmt_training_samples') as any).select('status');
  const counts: Record<string, number> = { all: (allRows || []).length };
  for (const r of (allRows || []) as any[]) {
    counts[r.status] = (counts[r.status] || 0) + 1;
  }

  return { data: (data || []) as any[], counts };
}

export async function reviewSample(
  id: string,
  action: 'confirm' | 'reject' | 'needs_edit',
  updates?: Partial<{
    garment_type: string;
    garment_subtype: string;
    style_no: string;
    customer_name: string;
    factory_name: string;
    total_cmt_rmb: number;
    operations: any[];
    review_notes: string;
  }>,
): Promise<{ error?: string; success?: boolean }> {
  const auth = await checkTrainingAccess();
  if (!auth.ok || !auth.userId) return { error: auth.error };

  const supabase = await createClient();
  const status =
    action === 'confirm' ? 'confirmed' : action === 'reject' ? 'rejected' : 'needs_edit';

  const payload: any = {
    status,
    reviewed_by: auth.userId,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...(updates || {}),
  };

  const { error } = await (supabase.from('quoter_cmt_training_samples') as any)
    .update(payload)
    .eq('id', id);
  if (error) return { error: error.message };

  revalidatePath('/quoter/training');
  return { success: true };
}

export async function deleteSample(id: string): Promise<{ error?: string; success?: boolean }> {
  const auth = await checkTrainingAccess();
  if (!auth.ok) return { error: auth.error };

  const supabase = await createClient();
  // 先取 storage_path
  const { data } = await (supabase.from('quoter_cmt_training_samples') as any)
    .select('storage_path')
    .eq('id', id)
    .single();
  if ((data as any)?.storage_path) {
    await supabase.storage.from('order-docs').remove([(data as any).storage_path]);
  }
  const { error } = await (supabase.from('quoter_cmt_training_samples') as any).delete().eq('id', id);
  if (error) return { error: error.message };

  revalidatePath('/quoter/training');
  return { success: true };
}

/**
 * 重新跑 AI 提取（如果初次失败或内容变更）
 */
export async function reExtractSample(id: string): Promise<{ error?: string; success?: boolean }> {
  const auth = await checkTrainingAccess();
  if (!auth.ok) return { error: auth.error };

  const supabase = await createClient();
  const { data: sample } = await (supabase.from('quoter_cmt_training_samples') as any)
    .select('id, source_type, storage_path, source_file_name')
    .eq('id', id)
    .single();
  if (!sample) return { error: '样本不存在' };

  const s = sample as any;
  try {
    if (s.source_type === 'image') {
      const mime = /\.png$/i.test(s.source_file_name) ? 'image/png' : 'image/jpeg';
      await extractFromImage(s.id, s.storage_path, mime);
    } else if (s.source_type === 'excel') {
      await extractFromExcel(s.id, s.storage_path);
    } else {
      return { error: '该类型不支持自动提取' };
    }
  } catch (e: any) {
    return { error: '提取异常：' + (e?.message || e) };
  }

  revalidatePath('/quoter/training');
  return { success: true };
}

// ════════════════════════════════════════════════
// 从已完成订单自动导入训练数据
// ════════════════════════════════════════════════

/**
 * 将已完成订单的实际加工费导入为训练样本
 * 数据来源：order_cost_baseline.cmt_factory_quote + orders 表
 * 自动标记 status='confirmed'（信任实际生产数据）
 */
export async function syncOrdersToTraining(): Promise<{
  imported: number;
  skipped: number;
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { imported: 0, skipped: 0, error: '未登录' };

  // 查有成本基线且有加工费的订单
  const { data: baselines } = await (supabase.from('order_cost_baseline') as any)
    .select('order_id, cmt_factory_quote, cmt_internal_estimate, fabric_consumption_kg');

  if (!baselines || baselines.length === 0) return { imported: 0, skipped: 0 };

  // 查已导入的订单 ID（去重）
  const { data: existingSamples } = await (supabase.from('quoter_cmt_training_samples') as any)
    .select('source_order_id')
    .eq('source_type', 'order_actual')
    .not('source_order_id', 'is', null);
  const importedOrderIds = new Set((existingSamples || []).map((s: any) => s.source_order_id));

  const orderIds = baselines
    .filter((b: any) => b.cmt_factory_quote && b.cmt_factory_quote > 0)
    .map((b: any) => b.order_id)
    .filter((id: string) => !importedOrderIds.has(id));

  if (orderIds.length === 0) return { imported: 0, skipped: baselines.length };

  const { data: orders } = await (supabase.from('orders') as any)
    .select('id, order_no, customer_name, factory_name, style_no, order_type')
    .in('id', orderIds);

  const orderMap = new Map((orders || []).map((o: any) => [o.id, o]));
  let imported = 0;

  for (const baseline of baselines as any[]) {
    if (!baseline.cmt_factory_quote || baseline.cmt_factory_quote <= 0) continue;
    if (importedOrderIds.has(baseline.order_id)) continue;

    const order = orderMap.get(baseline.order_id);
    if (!order) continue;

    const { error } = await (supabase.from('quoter_cmt_training_samples') as any).insert({
      source_type: 'order_actual',
      source_order_id: baseline.order_id,
      garment_type: 'knit_top', // 默认，后续可从订单元数据推断
      style_no: order.style_no || order.order_no,
      customer_name: order.customer_name,
      factory_name: order.factory_name,
      total_cmt_rmb: baseline.cmt_factory_quote,
      operations: [],
      status: 'confirmed',
      uploaded_by: user.id,
    });

    if (!error) imported++;
  }

  revalidatePath('/quoter/training');
  return { imported, skipped: baselines.length - imported };
}
