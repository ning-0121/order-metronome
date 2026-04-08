'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export interface ProductionReport {
  id: string;
  order_id: string;
  report_date: string;
  reported_by: string | null;
  reporter_name?: string;
  qty_produced: number;
  qty_cumulative: number;
  qty_defect: number;
  defect_rate: number;
  workers_count: number | null;
  efficiency_rate: number | null;
  issues: string | null;
  notes: string | null;
  created_at: string;
}

export interface ProductionAnalysis {
  totalQty: number;
  completedQty: number;
  progressRate: number;        // 完成率 %
  timeProgressRate: number;    // 时间进度 %
  daysUsed: number;
  daysRemaining: number;
  totalProductionDays: number;
  dailyAvgOutput: number;      // 日均产量
  requiredDailyOutput: number; // 剩余需日均
  totalDefects: number;
  avgDefectRate: number;
  riskLevel: 'green' | 'yellow' | 'red';
  riskLabel: string;
  suggestion: string;
}

export async function getProductionReports(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  const { data, error } = await (supabase.from('production_reports') as any)
    .select('*')
    .eq('order_id', orderId)
    .order('report_date', { ascending: false });

  if (error) return { error: error.message };

  // 关联报告人姓名
  const reports = (data || []) as ProductionReport[];
  if (reports.length > 0) {
    const userIds = [...new Set(reports.map(r => r.reported_by).filter(Boolean))];
    if (userIds.length > 0) {
      const { data: profiles } = await (supabase.from('profiles') as any)
        .select('user_id, name, email')
        .in('user_id', userIds);
      const map = new Map((profiles || []).map((p: any) => [p.user_id, p.name || p.email?.split('@')[0] || '未知']));
      for (const r of reports) {
        r.reporter_name = r.reported_by ? (map.get(r.reported_by) as string) || '未知' : '未知';
      }
    }
  }

  return { data: reports };
}

export async function addProductionReport(
  orderId: string,
  report: {
    report_date: string;
    qty_produced: number;
    qty_defect: number;
    workers_count?: number;
    issues?: string;
    notes?: string;
  }
): Promise<{ error?: string; success?: boolean; reportId?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  // 权限：跟单或业务可填写
  const { data: profile } = await supabase.from('profiles').select('role, roles').eq('user_id', user.id).single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const canReport = userRoles.some(r => ['sales', 'merchandiser', 'admin'].includes(r));
  if (!canReport) return { error: '仅跟单或业务可更新生产进度' };

  // 计算累计产量
  const { data: existing } = await (supabase.from('production_reports') as any)
    .select('qty_produced')
    .eq('order_id', orderId)
    .order('report_date', { ascending: true });

  const prevCumulative = (existing || []).reduce((sum: number, r: any) => sum + (r.qty_produced || 0), 0);
  const qty_cumulative = prevCumulative + (report.qty_produced || 0);

  const { data: inserted, error } = await (supabase.from('production_reports') as any).insert({
    order_id: orderId,
    reported_by: user.id,
    report_date: report.report_date,
    qty_produced: report.qty_produced || 0,
    qty_cumulative,
    qty_defect: report.qty_defect || 0,
    workers_count: report.workers_count || null,
    issues: report.issues || null,
    notes: report.notes || null,
  }).select('id').single();

  if (error) {
    if (error.message?.includes('unique') || error.message?.includes('duplicate')) {
      return { error: '该日期已有记录，每天只能提交一条日报。请删除旧记录再填写。' };
    }
    return { error: error.message };
  }

  revalidatePath(`/orders/${orderId}`);
  return { success: true, reportId: (inserted as any)?.id };
}

// ════════════════════════════════════════════════
// 生产日报附件（跟单每日上传资料/图片/手写稿）
// ════════════════════════════════════════════════

export interface ProductionReportAttachment {
  id: string;
  production_report_id: string;
  file_name: string;
  file_url: string;
  mime_type: string | null;
  file_size: number | null;
  uploaded_by: string | null;
  uploader_name?: string;
  created_at: string;
  extracted_text: string | null;
  extracted_at: string | null;
}

/**
 * 上传生产日报附件（跟单每日材料/图片/手写稿）
 */
export async function uploadProductionReportFile(
  orderId: string,
  reportId: string,
  file: File,
): Promise<{ error?: string; data?: ProductionReportAttachment }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: profile } = await supabase.from('profiles').select('role, roles').eq('user_id', user.id).single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const canReport = userRoles.some(r => ['sales', 'merchandiser', 'admin'].includes(r));
  if (!canReport) return { error: '仅跟单或业务可上传生产资料' };

  const fileExt = file.name.split('.').pop() || 'bin';
  const storagePath = `${orderId}/production/${reportId}_${Date.now()}.${fileExt}`;

  const { error: uploadError } = await supabase.storage
    .from('order-docs')
    .upload(storagePath, file, { contentType: file.type || undefined, upsert: false });
  if (uploadError) return { error: `上传失败: ${uploadError.message}` };

  const { data: { publicUrl } } = supabase.storage.from('order-docs').getPublicUrl(storagePath);

  const { data: row, error: insertError } = await (supabase.from('order_attachments') as any)
    .insert({
      order_id: orderId,
      production_report_id: reportId,
      file_url: publicUrl,
      storage_path: storagePath,
      file_name: file.name,
      file_type: 'production_report',
      file_size: file.size,
      mime_type: file.type || null,
      uploaded_by: user.id,
    })
    .select('id, production_report_id, file_name, file_url, mime_type, file_size, uploaded_by, created_at, extracted_text, extracted_at')
    .single();

  if (insertError) {
    await supabase.storage.from('order-docs').remove([storagePath]);
    return { error: `写入失败: ${insertError.message}` };
  }

  revalidatePath(`/orders/${orderId}`);
  return { data: row as any };
}

/**
 * 列出某个订单所有生产日报的附件
 */
export async function getProductionReportAttachments(orderId: string): Promise<{
  data?: ProductionReportAttachment[];
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data, error } = await (supabase.from('order_attachments') as any)
    .select('id, production_report_id, file_name, file_url, mime_type, file_size, uploaded_by, created_at, extracted_text, extracted_at')
    .eq('order_id', orderId)
    .eq('file_type', 'production_report')
    .order('created_at', { ascending: false });
  if (error) return { error: error.message };

  const rows = (data || []) as ProductionReportAttachment[];
  const userIds = [...new Set(rows.map(r => r.uploaded_by).filter(Boolean))];
  if (userIds.length > 0) {
    const { data: profiles } = await (supabase.from('profiles') as any)
      .select('user_id, name, email')
      .in('user_id', userIds);
    const nameMap = new Map(
      (profiles || []).map((p: any) => [p.user_id, p.name || p.email?.split('@')[0] || '未知'])
    );
    for (const r of rows) {
      r.uploader_name = r.uploaded_by ? (nameMap.get(r.uploaded_by) as string) || '未知' : '未知';
    }
  }
  return { data: rows };
}

/**
 * 删除生产日报附件
 */
export async function deleteProductionReportFile(attachmentId: string, orderId: string): Promise<{ error?: string; success?: boolean }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: row } = await (supabase.from('order_attachments') as any)
    .select('id, uploaded_by, storage_path, order_id, file_type')
    .eq('id', attachmentId)
    .single();
  if (!row) return { error: '附件不存在' };
  if ((row as any).file_type !== 'production_report') return { error: '该附件不是生产日报附件' };

  const { data: profile } = await supabase.from('profiles').select('role, roles').eq('user_id', user.id).single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const isAdmin = userRoles.includes('admin');
  const isOwner = (row as any).uploaded_by === user.id;
  if (!isAdmin && !isOwner) return { error: '只有上传者本人或管理员可删除' };

  if ((row as any).storage_path) {
    await supabase.storage.from('order-docs').remove([(row as any).storage_path]);
  }
  const { error } = await (supabase.from('order_attachments') as any).delete().eq('id', attachmentId);
  if (error) return { error: error.message };

  revalidatePath(`/orders/${orderId}`);
  return { success: true };
}

/**
 * AI 识别：把图片（手写稿/打印稿/照片）转换为结构化文本
 * 使用 Claude Vision，结果写回 order_attachments.extracted_text
 */
export async function extractTextFromAttachment(attachmentId: string): Promise<{
  error?: string;
  extracted_text?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: row } = await (supabase.from('order_attachments') as any)
    .select('id, file_url, mime_type, file_name, order_id, storage_path')
    .eq('id', attachmentId)
    .single();
  if (!row) return { error: '附件不存在' };

  const mime = (row as any).mime_type || '';
  if (!mime.startsWith('image/')) {
    return { error: '目前只支持图片识别（PDF/文档请人工录入）' };
  }

  // 下载图片为 base64
  let base64: string;
  try {
    const { data: fileBlob, error: dlErr } = await supabase.storage
      .from('order-docs')
      .download((row as any).storage_path);
    if (dlErr || !fileBlob) return { error: `下载图片失败: ${dlErr?.message || '未知'}` };
    const arrayBuf = await fileBlob.arrayBuffer();
    base64 = Buffer.from(arrayBuf).toString('base64');
  } catch (e: any) {
    return { error: `读取图片失败: ${e?.message || e}` };
  }

  // 调用 Claude Vision
  const { callClaude } = await import('@/lib/agent/anthropicClient');
  const result = await callClaude({
    scene: 'production-ocr',
    model: 'claude-sonnet-4-20250514',
    maxTokens: 2048,
    timeoutMs: 45_000,
    system: '你是一个服装生产车间的跟单助手，专门把车间的手写/打印单据识别成结构化中文文本。',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: (mime as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'),
              data: base64,
            },
          },
          {
            type: 'text',
            text: `请识别这张图片的内容，用中文输出：
1. 如果是手写/打印的生产记录单（如开裁单/裁床日报/车间日报），按表格/字段整理出关键信息：日期、订单号、款号、数量、工序、异常、签字人等。
2. 如果是生产现场照片，用 2-3 句话描述所见（场景、状态、是否异常）。
3. 如果是品质问题照片，说明缺陷位置和类型。
输出格式：纯文本，不要 markdown 代码块。`,
          },
        ],
      },
    ],
  });

  if (!result?.text) return { error: 'AI 识别失败或超时，请稍后重试' };

  const extracted = result.text.trim();
  const { error: updErr } = await (supabase.from('order_attachments') as any)
    .update({ extracted_text: extracted, extracted_at: new Date().toISOString() })
    .eq('id', attachmentId);
  if (updErr) return { error: `写入识别结果失败: ${updErr.message}` };

  revalidatePath(`/orders/${(row as any).order_id}`);
  return { extracted_text: extracted };
}

export async function deleteProductionReport(reportId: string, orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  const { data: profile } = await supabase.from('profiles').select('role, roles').eq('user_id', user.id).single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  if (!userRoles.includes('admin')) return { error: '仅管理员可删除日报' };

  await (supabase.from('production_reports') as any).delete().eq('id', reportId);
  revalidatePath(`/orders/${orderId}`);
  return { success: true };
}

/**
 * AI 生产进度分析（纯算法，不调 API）
 */
export async function getProductionAnalysis(orderId: string): Promise<{ data?: ProductionAnalysis; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  // 获取订单信息
  const { data: order } = await (supabase.from('orders') as any)
    .select('quantity, etd, warehouse_due_date, incoterm')
    .eq('id', orderId)
    .single();
  if (!order) return { error: '订单不存在' };

  const totalQty = order.quantity || 0;
  if (totalQty === 0) return { error: '订单未设置数量，无法分析' };

  // 获取生产启动和工厂完成关卡日期
  const { data: milestones } = await (supabase.from('milestones') as any)
    .select('step_key, due_at, status')
    .eq('order_id', orderId)
    .in('step_key', ['production_kickoff', 'factory_completion']);

  const kickoff = (milestones || []).find((m: any) => m.step_key === 'production_kickoff');
  const completion = (milestones || []).find((m: any) => m.step_key === 'factory_completion');

  if (!kickoff?.due_at || !completion?.due_at) return { error: '缺少生产启动或工厂完成日期' };

  const startDate = new Date(kickoff.due_at);
  const endDate = new Date(completion.due_at);
  const now = new Date();

  const totalProductionDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / 86400000));
  const daysUsed = Math.max(0, Math.ceil((now.getTime() - startDate.getTime()) / 86400000));
  const daysRemaining = Math.max(0, Math.ceil((endDate.getTime() - now.getTime()) / 86400000));

  // 获取生产日报
  const { data: reports } = await (supabase.from('production_reports') as any)
    .select('qty_produced, qty_defect')
    .eq('order_id', orderId);

  const completedQty = (reports || []).reduce((sum: number, r: any) => sum + (r.qty_produced || 0), 0);
  const totalDefects = (reports || []).reduce((sum: number, r: any) => sum + (r.qty_defect || 0), 0);

  const progressRate = Math.round((completedQty / totalQty) * 100);
  const timeProgressRate = Math.round((daysUsed / totalProductionDays) * 100);
  const dailyAvgOutput = daysUsed > 0 ? Math.round(completedQty / daysUsed) : 0;
  const requiredDailyOutput = daysRemaining > 0 ? Math.ceil((totalQty - completedQty) / daysRemaining) : 0;
  const avgDefectRate = completedQty > 0 ? Math.round((totalDefects / completedQty) * 1000) / 10 : 0;

  // 风险评估
  let riskLevel: 'green' | 'yellow' | 'red' = 'green';
  let riskLabel = '正常';
  let suggestion = '';

  if (daysUsed === 0 || (reports || []).length === 0) {
    riskLevel = 'green';
    riskLabel = '待开始';
    suggestion = '生产尚未开始或未提交日报，请跟单及时更新进度。';
  } else if (progressRate >= timeProgressRate) {
    riskLevel = 'green';
    riskLabel = '正常';
    suggestion = `生产进度正常，完成率 ${progressRate}% 超过时间进度 ${timeProgressRate}%，继续保持。`;
  } else if (progressRate >= timeProgressRate - 10) {
    riskLevel = 'yellow';
    riskLabel = '注意';
    suggestion = `生产略有滞后，完成率 ${progressRate}% 低于时间进度 ${timeProgressRate}%。日均需 ${requiredDailyOutput} 件，当前日均 ${dailyAvgOutput} 件，需要加快。`;
  } else {
    riskLevel = 'red';
    riskLabel = '危险';
    suggestion = `生产严重滞后！完成率 ${progressRate}% 远低于时间进度 ${timeProgressRate}%。剩余 ${daysRemaining} 天需完成 ${totalQty - completedQty} 件（日均 ${requiredDailyOutput} 件），当前日均仅 ${dailyAvgOutput} 件，请立即协调！`;
  }

  if (avgDefectRate > 5) {
    suggestion += ` 注意：不良率 ${avgDefectRate}% 偏高，请关注品质。`;
  }

  return {
    data: {
      totalQty, completedQty, progressRate, timeProgressRate,
      daysUsed, daysRemaining, totalProductionDays,
      dailyAvgOutput, requiredDailyOutput,
      totalDefects, avgDefectRate,
      riskLevel, riskLabel, suggestion,
    },
  };
}
