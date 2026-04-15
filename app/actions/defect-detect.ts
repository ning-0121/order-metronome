'use server';

/**
 * AI 质检缺陷识别 — 服务端 Action
 *
 * 跟单上传照片后调用，返回 AI 识别的缺陷报告
 */

import { createClient } from '@/lib/supabase/server';
import type { DefectDetectionResult } from '@/lib/agent/skills/garmentDefectDetect';

// 哪些 milestone step_key 触发 AI 质检
const QC_STEP_KEYS = new Set([
  'pre_production_sample_ready',  // 封样
  'materials_received_inspected', // 面料验收
  'production_kickoff',          // 上线工艺确认
  'mid_qc_check',                // 中查
  'mid_qc_sales_check',          // 业务中查
  'final_qc_check',              // 尾查
  'final_qc_sales_check',        // 业务尾查
  'packing_method_confirmed',    // 包装确认
  'inspection_release',          // 验货放行
]);

// step_key → 检查场景映射
const STEP_TO_SCENE: Record<string, string> = {
  pre_production_sample_ready: 'sample',
  materials_received_inspected: 'fabric',
  production_kickoff: 'general',
  mid_qc_check: 'mid_qc',
  mid_qc_sales_check: 'mid_qc',
  final_qc_check: 'final_qc',
  final_qc_sales_check: 'final_qc',
  packing_method_confirmed: 'packing',
  inspection_release: 'final_qc',
};

/**
 * 检测单张已上传的附件照片
 */
export async function detectDefectsFromAttachment(
  attachmentId: string,
): Promise<{ data?: DefectDetectionResult; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // 获取附件信息
  const { data: attachment } = await (supabase.from('order_attachments') as any)
    .select('id, file_url, mime_type, file_name, storage_path, milestone_id, order_id')
    .eq('id', attachmentId)
    .single();

  if (!attachment) return { error: '附件不存在' };
  if (!attachment.mime_type?.startsWith('image/')) {
    return { error: '仅支持图片格式（JPG/PNG）进行AI质检分析' };
  }

  // 获取 milestone 信息（确定检查场景）
  let scene = 'general';
  let orderContext = '';
  if (attachment.milestone_id) {
    const { data: milestone } = await (supabase.from('milestones') as any)
      .select('step_key, name, order_id')
      .eq('id', attachment.milestone_id)
      .single();
    if (milestone) {
      scene = STEP_TO_SCENE[milestone.step_key] || 'general';
    }
  }

  // 获取订单信息（提供上下文）
  if (attachment.order_id) {
    const { data: order } = await (supabase.from('orders') as any)
      .select('order_no, customer_name, quantity, style_no')
      .eq('id', attachment.order_id)
      .single();
    if (order) {
      orderContext = `订单${order.order_no}，客户${order.customer_name}，款号${order.style_no || '?'}，数量${order.quantity || '?'}件`;
    }
  }

  // 下载图片
  const storagePath = attachment.storage_path
    || attachment.file_url?.replace(/^.*\/order-docs\//, '');
  if (!storagePath) return { error: '无法获取文件路径' };

  try {
    const { data: blob, error: dlErr } = await supabase.storage
      .from('order-docs')
      .download(storagePath);
    if (dlErr || !blob) return { error: `下载图片失败: ${dlErr?.message || '未知'}` };

    const arrayBuf = await blob.arrayBuffer();
    const base64 = Buffer.from(arrayBuf).toString('base64');

    const { detectGarmentDefects } = await import('@/lib/agent/skills/garmentDefectDetect');
    const result = await detectGarmentDefects(
      base64,
      attachment.mime_type,
      scene as any,
      orderContext,
    );

    if (!result) return { error: 'AI 分析失败，请稍后重试' };

    // 保存分析结果到附件记录（方便后续查看）
    try {
      await (supabase.from('order_attachments') as any)
        .update({
          ai_analysis: result,
          ai_analyzed_at: new Date().toISOString(),
        })
        .eq('id', attachmentId);
    } catch {} // 保存失败不影响返回结果

    return { data: result };
  } catch (err: any) {
    return { error: `AI分析异常: ${err?.message || '未知错误'}` };
  }
}

/**
 * 检测某个订单+节点下所有已上传的照片
 */
export async function detectDefectsForMilestone(
  orderId: string,
  milestoneId: string,
): Promise<{ data?: DefectDetectionResult; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // 检查节点是否支持AI质检
  const { data: milestone } = await (supabase.from('milestones') as any)
    .select('step_key, name')
    .eq('id', milestoneId)
    .single();
  if (!milestone) return { error: '节点不存在' };
  if (!QC_STEP_KEYS.has(milestone.step_key)) {
    return { error: '该节点不支持AI质检分析' };
  }

  // 获取该节点的所有图片附件
  const { data: attachments } = await (supabase.from('order_attachments') as any)
    .select('id, file_url, mime_type, file_name, storage_path')
    .eq('order_id', orderId)
    .eq('milestone_id', milestoneId)
    .order('created_at', { ascending: false });

  const images = (attachments || []).filter((a: any) => a.mime_type?.startsWith('image/'));
  if (images.length === 0) {
    return { error: '该节点暂无图片附件，请先上传质检照片' };
  }

  // 下载并分析
  const scene = STEP_TO_SCENE[milestone.step_key] || 'general';
  const { data: order } = await (supabase.from('orders') as any)
    .select('order_no, customer_name, quantity, style_no')
    .eq('id', orderId)
    .single();
  const orderContext = order
    ? `订单${order.order_no}，客户${order.customer_name}，款号${order.style_no || '?'}，数量${order.quantity || '?'}件`
    : '';

  const imageData: Array<{ base64: string; mimeType: string; fileName: string }> = [];
  for (const img of images.slice(0, 5)) {
    try {
      const storagePath = img.storage_path || img.file_url?.replace(/^.*\/order-docs\//, '');
      if (!storagePath) continue;
      const { data: blob } = await supabase.storage.from('order-docs').download(storagePath);
      if (!blob) continue;
      const buf = await blob.arrayBuffer();
      imageData.push({
        base64: Buffer.from(buf).toString('base64'),
        mimeType: img.mime_type,
        fileName: img.file_name,
      });
    } catch {}
  }

  if (imageData.length === 0) {
    return { error: '无法读取图片文件' };
  }

  const { detectDefectsBatch } = await import('@/lib/agent/skills/garmentDefectDetect');
  const result = await detectDefectsBatch(imageData, scene as any, orderContext);

  return { data: result };
}

/**
 * 判断某个 step_key 是否支持 AI 质检
 */
export async function isQCStep(stepKey: string): Promise<boolean> {
  return QC_STEP_KEYS.has(stepKey);
}
