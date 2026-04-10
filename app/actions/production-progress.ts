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
  // 增强字段
  productionStarted: boolean;  // production_kickoff 是否已完成
  shouldReport: boolean;       // 是否应该提交日报
  daysSinceKickoff: number;    // 启动后多少天
  trend: 'up' | 'flat' | 'down' | 'unknown';
  trendDetail: string;
  defectTrend: 'normal' | 'rising' | 'unknown';
  efficiencyPerWorker: number; // 人均日产
  warnings: string[];          // 具体风险警告列表
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

  // 并行加载订单 + 里程碑 + 日报
  const [orderRes, msRes, reportsRes] = await Promise.all([
    (supabase.from('orders') as any)
      .select('quantity, etd, warehouse_due_date, incoterm')
      .eq('id', orderId).single(),
    (supabase.from('milestones') as any)
      .select('step_key, due_at, actual_at, status')
      .eq('order_id', orderId)
      .in('step_key', ['production_kickoff', 'factory_completion']),
    (supabase.from('production_reports') as any)
      .select('qty_produced, qty_defect, workers_count, report_date')
      .eq('order_id', orderId)
      .order('report_date', { ascending: true }),
  ]);

  const order = orderRes.data;
  if (!order) return { error: '订单不存在' };
  const totalQty = order.quantity || 0;
  if (totalQty === 0) return { error: '订单未设置数量，无法分析' };

  const milestones = (msRes.data || []) as any[];
  const kickoff = milestones.find((m: any) => m.step_key === 'production_kickoff');
  const completion = milestones.find((m: any) => m.step_key === 'factory_completion');

  if (!kickoff?.due_at || !completion?.due_at) return { error: '缺少生产启动或工厂完成日期' };

  // 生产启动状态检测
  const DONE = new Set(['done', '已完成', 'completed']);
  const ACTIVE = new Set(['in_progress', '进行中']);
  const productionStarted = DONE.has(kickoff.status) || ACTIVE.has(kickoff.status);
  const kickoffActual = kickoff.actual_at ? new Date(kickoff.actual_at) : null;

  const startDate = kickoffActual || new Date(kickoff.due_at);
  const endDate = new Date(completion.due_at);
  const now = new Date();

  const totalProductionDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / 86400000));
  const daysUsed = Math.max(0, Math.ceil((now.getTime() - startDate.getTime()) / 86400000));
  const daysRemaining = Math.max(0, Math.ceil((endDate.getTime() - now.getTime()) / 86400000));
  const daysSinceKickoff = kickoffActual
    ? Math.max(0, Math.ceil((now.getTime() - kickoffActual.getTime()) / 86400000))
    : daysUsed;

  const reports = (reportsRes.data || []) as any[];
  const completedQty = reports.reduce((sum: number, r: any) => sum + (r.qty_produced || 0), 0);
  const totalDefects = reports.reduce((sum: number, r: any) => sum + (r.qty_defect || 0), 0);

  const progressRate = totalQty > 0 ? Math.round((completedQty / totalQty) * 100) : 0;
  const timeProgressRate = Math.round((daysUsed / totalProductionDays) * 100);
  const dailyAvgOutput = daysUsed > 0 ? Math.round(completedQty / daysUsed) : 0;
  const requiredDailyOutput = daysRemaining > 0 ? Math.ceil((totalQty - completedQty) / daysRemaining) : 0;
  const avgDefectRate = completedQty > 0 ? Math.round((totalDefects / completedQty) * 1000) / 10 : 0;

  // ═══ 趋势分析 ═══
  const recent5 = reports.slice(-5);
  let trend: 'up' | 'flat' | 'down' | 'unknown' = 'unknown';
  let trendDetail = '';
  if (recent5.length >= 3) {
    const firstHalf = recent5.slice(0, Math.floor(recent5.length / 2));
    const secondHalf = recent5.slice(Math.floor(recent5.length / 2));
    const avgFirst = firstHalf.reduce((s: number, r: any) => s + (r.qty_produced || 0), 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((s: number, r: any) => s + (r.qty_produced || 0), 0) / secondHalf.length;
    if (avgSecond > avgFirst * 1.15) {
      trend = 'up';
      trendDetail = `最近产量上升（日均 ${Math.round(avgSecond)} 件 vs 前期 ${Math.round(avgFirst)} 件）`;
    } else if (avgSecond < avgFirst * 0.85) {
      trend = 'down';
      trendDetail = `最近产量下降（日均 ${Math.round(avgSecond)} 件 vs 前期 ${Math.round(avgFirst)} 件）`;
    } else {
      trend = 'flat';
      trendDetail = `产量稳定（日均约 ${Math.round(avgSecond)} 件）`;
    }
  }

  // ═══ 不良率趋势 ═══
  let defectTrend: 'normal' | 'rising' | 'unknown' = 'unknown';
  const recent3 = reports.slice(-3);
  if (recent3.length >= 3) {
    const recent3Defects = recent3.reduce((s: number, r: any) => s + (r.qty_defect || 0), 0);
    const recent3Qty = recent3.reduce((s: number, r: any) => s + (r.qty_produced || 0), 0);
    const recentDefectRate = recent3Qty > 0 ? (recent3Defects / recent3Qty) * 100 : 0;
    defectTrend = recentDefectRate > avgDefectRate * 1.5 && recentDefectRate > 3 ? 'rising' : 'normal';
  }

  // ═══ 人均效率 ═══
  const reportsWithWorkers = reports.filter((r: any) => r.workers_count > 0 && r.qty_produced > 0);
  const efficiencyPerWorker = reportsWithWorkers.length > 0
    ? Math.round(reportsWithWorkers.reduce((s: number, r: any) => s + r.qty_produced / r.workers_count, 0) / reportsWithWorkers.length)
    : 0;

  // ═══ 风险评估 + 警告 ═══
  let riskLevel: 'green' | 'yellow' | 'red' = 'green';
  let riskLabel = '正常';
  let suggestion = '';
  const warnings: string[] = [];
  const shouldReport = productionStarted;

  if (!productionStarted) {
    riskLevel = 'green';
    riskLabel = '待开始';
    suggestion = '生产尚未启动，无需提交日报。启动后请每日更新进度。';
  } else if (reports.length === 0) {
    // 生产已启动但无日报
    riskLevel = daysSinceKickoff >= 3 ? 'red' : 'yellow';
    riskLabel = daysSinceKickoff >= 3 ? '失联' : '待报';
    suggestion = daysSinceKickoff >= 3
      ? `生产已启动 ${daysSinceKickoff} 天但无任何日报！请立即联系工厂确认生产状况，${daysRemaining} 天后需出厂。`
      : `生产刚启动，请尽快提交第一份日报以便系统追踪进度。`;
    if (daysSinceKickoff >= 3) warnings.push(`生产启动 ${daysSinceKickoff} 天无日报`);
  } else if (progressRate >= timeProgressRate) {
    riskLevel = 'green';
    riskLabel = '正常';
    suggestion = `进度正常 — 完成 ${progressRate}%，时间过 ${timeProgressRate}%。日均 ${dailyAvgOutput} 件，保持即可。`;
  } else if (progressRate >= timeProgressRate - 10) {
    riskLevel = 'yellow';
    riskLabel = '注意';
    const gap = requiredDailyOutput - dailyAvgOutput;
    suggestion = `进度略滞后 — 需日均 ${requiredDailyOutput} 件，当前 ${dailyAvgOutput} 件，缺口 ${gap} 件/天。`;
    warnings.push(`产能缺口 ${gap} 件/天`);
  } else {
    riskLevel = 'red';
    riskLabel = '危险';
    suggestion = `严重滞后！剩 ${daysRemaining} 天要完成 ${totalQty - completedQty} 件（需日均 ${requiredDailyOutput} 件），当前日均仅 ${dailyAvgOutput} 件。`;
    warnings.push(`需日均 ${requiredDailyOutput} 件，实际仅 ${dailyAvgOutput} 件`);
  }

  // 趋势下降 + 时间紧 → 加重警告
  if (trend === 'down' && daysRemaining <= 10) {
    if (riskLevel === 'yellow') riskLevel = 'red';
    warnings.push('产量呈下降趋势且剩余时间不多');
  }

  // 不良率上升
  if (defectTrend === 'rising') {
    warnings.push(`不良率上升至 ${avgDefectRate}%，建议安排跟单盯品质`);
  }

  // 人效偏低
  if (efficiencyPerWorker > 0 && efficiencyPerWorker < 20) {
    warnings.push(`人均日产仅 ${efficiencyPerWorker} 件，效率偏低`);
  }

  // 工人减少
  if (reportsWithWorkers.length >= 2) {
    const lastWorkers = reportsWithWorkers[reportsWithWorkers.length - 1].workers_count;
    const prevWorkers = reportsWithWorkers[reportsWithWorkers.length - 2].workers_count;
    if (lastWorkers < prevWorkers * 0.7) {
      warnings.push(`工人从 ${prevWorkers} 人减少到 ${lastWorkers} 人，产能可能不足`);
    }
  }

  return {
    data: {
      totalQty, completedQty, progressRate, timeProgressRate,
      daysUsed, daysRemaining, totalProductionDays,
      dailyAvgOutput, requiredDailyOutput,
      totalDefects, avgDefectRate,
      riskLevel, riskLabel, suggestion,
      productionStarted, shouldReport, daysSinceKickoff,
      trend, trendDetail, defectTrend,
      efficiencyPerWorker, warnings,
    },
  };
}
