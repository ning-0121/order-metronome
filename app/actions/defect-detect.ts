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
    } catch (e: any) { console.warn(`[defect-detect] 缺陷识别附属操作:`, e?.message); }
  }

  if (imageData.length === 0) {
    return { error: '无法读取图片文件' };
  }

  const { detectDefectsBatch } = await import('@/lib/agent/skills/garmentDefectDetect');
  const result = await detectDefectsBatch(imageData, scene as any, orderContext);

  return { data: result };
}

