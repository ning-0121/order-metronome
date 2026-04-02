'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { DOCUMENT_TYPES, COMPANY_INFO, type DocumentType } from '@/lib/domain/document-templates';
import { isAdmin as checkIsAdmin } from '@/lib/utils/user-role';
import Anthropic from '@anthropic-ai/sdk';

// ══════ 价格敏感单据 ══════
// PI 和 CI 含有客户单价/总价，仅限 CEO/管理员、财务、订单负责业务可见
const PRICE_SENSITIVE_DOC_TYPES: DocumentType[] = ['pi', 'ci'];

/**
 * 判断用户是否有权查看价格敏感单据
 * 允许：admin、finance 角色、订单的 owner/creator/merchandiser
 */
async function canViewPriceSensitiveDoc(
  supabase: any,
  userId: string,
  userEmail: string,
  orderId: string,
): Promise<boolean> {
  // 管理员直接放行
  if (checkIsAdmin(userEmail)) return true;

  // 查询用户角色
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', userId)
    .single();

  const roles: string[] = profile?.roles?.length > 0 ? profile.roles : [profile?.role].filter(Boolean);
  if (roles.includes('finance') || roles.includes('admin')) return true;

  // 查询订单：是否为此订单的负责人/创建者/跟单员
  const { data: order } = await (supabase.from('orders') as any)
    .select('created_by, owner_user_id, merchandiser_user_id')
    .eq('id', orderId)
    .single();

  if (!order) return false;
  return order.created_by === userId || order.owner_user_id === userId || order.merchandiser_user_id === userId;
}

// ══════ 查询 ══════

export async function getOrderDocuments(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: [] };

  const { data, error } = await (supabase.from('order_documents') as any)
    .select('*')
    .eq('order_id', orderId)
    .is('deleted_at', null)
    .order('document_type')
    .order('version_no', { ascending: false });

  if (error) return { data: [], error: error.message };

  // 权限过滤：价格敏感单据（PI/CI）仅限授权人员可见
  const allDocs = data || [];
  const hasSensitive = allDocs.some((d: any) => PRICE_SENSITIVE_DOC_TYPES.includes(d.document_type));

  if (hasSensitive) {
    const canView = await canViewPriceSensitiveDoc(supabase, user.id, user.email || '', orderId);
    if (!canView) {
      // 过滤掉价格敏感单据
      return { data: allDocs.filter((d: any) => !PRICE_SENSITIVE_DOC_TYPES.includes(d.document_type)) };
    }
  }

  return { data: allDocs };
}

// ══════ 创建（人工上传） ══════

export async function uploadDocument(
  orderId: string,
  documentType: DocumentType,
  fileName: string,
  filePath: string,
  fileUrl: string,
): Promise<{ data?: any; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // 价格敏感单据（PI/CI）仅限授权人员上传
  if (PRICE_SENSITIVE_DOC_TYPES.includes(documentType)) {
    const canView = await canViewPriceSensitiveDoc(supabase, user.id, user.email || '', orderId);
    if (!canView) {
      return { error: '无权操作价格相关单据，请联系管理员' };
    }
  }

  // 获取当前最大版本号
  const { data: existing } = await (supabase.from('order_documents') as any)
    .select('version_no')
    .eq('order_id', orderId)
    .eq('document_type', documentType)
    .order('version_no', { ascending: false })
    .limit(1);

  const nextVersion = (existing && existing.length > 0) ? existing[0].version_no + 1 : 1;

  // 获取订单号
  const { data: order } = await (supabase.from('orders') as any)
    .select('order_no').eq('id', orderId).single();
  const prefix = DOCUMENT_TYPES[documentType]?.prefix || 'DOC';
  const docNo = `${prefix}-${order?.order_no || ''}-V${nextVersion}`;

  const { data: doc, error } = await (supabase.from('order_documents') as any)
    .insert({
      order_id: orderId,
      document_type: documentType,
      source_mode: 'manual_upload',
      version_no: nextVersion,
      status: 'draft',
      document_no: docNo,
      file_name: fileName,
      file_path: filePath,
      file_url: fileUrl,
      created_by: user.id,
      is_current: true,
    })
    .select()
    .single();

  if (error) return { error: error.message };

  // 日志
  await logDocAction(supabase, doc.id, orderId, 'uploaded', user.id, { fileName });

  revalidatePath(`/orders/${orderId}`);
  return { data: doc };
}

// ══════ AI 生成 ══════

export async function aiGenerateDocument(
  orderId: string,
  documentType: DocumentType,
): Promise<{ data?: any; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // 价格敏感单据（PI/CI）仅限授权人员生成
  if (PRICE_SENSITIVE_DOC_TYPES.includes(documentType)) {
    const canView = await canViewPriceSensitiveDoc(supabase, user.id, user.email || '', orderId);
    if (!canView) {
      return { error: '无权操作价格相关单据，请联系管理员' };
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: 'AI 服务未配置' };

  // 获取订单数据
  const { data: order } = await (supabase.from('orders') as any)
    .select('*').eq('id', orderId).single();
  if (!order) return { error: '订单不存在' };

  // 构建上下文
  const orderContext = `订单号:${order.order_no}, 客户:${order.customer_name}, 工厂:${order.factory_name || ''}, PO号:${order.po_number || ''}, 数量:${order.quantity}件, 贸易条款:${order.incoterm}, 出厂日期:${order.factory_date || ''}, ETD:${order.etd || ''}, 订单类型:${order.order_type}`;

  const prompts: Record<string, string> = {
    pi: `根据以下订单信息生成 PI (Proforma Invoice) 草稿JSON。
公司信息: ${COMPANY_INFO.name_en}, ${COMPANY_INFO.address}
${orderContext}
返回JSON格式: {"pi_no":"自动","date":"今天","buyer":"客户名","items":[{"style_no":"","description":"","quantity":数量,"unit_price":0,"amount":0}],"subtotal":0,"freight":0,"total":0,"currency":"USD","payment_terms":"","delivery_terms":"贸易条款","port_of_loading":"","port_of_destination":"","remarks":""}`,

    production_sheet: `根据以下订单信息生成生产单草稿JSON。
${orderContext}
返回JSON: {"po_no":"PO号","style_no":"","customer":"客户","factory":"工厂","quantity":数量,"delivery_date":"出厂日期","fabric":"","color_breakdown":"","size_breakdown":"","craft_requirements":"","packing_requirements":"","trims":"","special_notes":""}`,

    packing_list: `根据以下订单信息生成装箱单草稿JSON。
${orderContext}
返回JSON: {"pl_no":"自动","items":[{"carton_no":"1-","style_no":"","color":"","size_breakdown":"","qty_per_carton":0,"carton_count":0,"total_qty":0,"nw_per_carton":0,"gw_per_carton":0,"carton_size":"","cbm":0}],"total_cartons":0,"total_qty":数量,"total_nw":0,"total_gw":0,"total_cbm":0}`,

    ci: `根据以下订单信息生成 CI (Commercial Invoice) 草稿JSON。
${orderContext}
返回JSON: {"ci_no":"自动","date":"今天","items":[{"style_no":"","description":"","quantity":数量,"unit_price":0,"amount":0}],"total_amount":0,"currency":"USD","port_of_loading":"","port_of_destination":"","vessel_voyage":"","bl_no":"","hs_code":"","remarks":""}`,
  };

  const prompt = prompts[documentType];
  if (!prompt) return { error: `暂不支持AI生成 ${documentType}` };

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: '你是外贸单据专家。根据订单信息生成单据草稿JSON。只返回JSON，不要其他内容。',
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content.filter(b => b.type === 'text').map(b => (b as Anthropic.TextBlock).text).join('');
    let jsonStr = text.trim();
    if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

    let parsed: any;
    try { parsed = JSON.parse(jsonStr); } catch { return { error: 'AI 返回格式异常，请重试' }; }

    // 获取版本号
    const { data: existing } = await (supabase.from('order_documents') as any)
      .select('version_no')
      .eq('order_id', orderId)
      .eq('document_type', documentType)
      .order('version_no', { ascending: false })
      .limit(1);

    const nextVersion = (existing && existing.length > 0) ? existing[0].version_no + 1 : 1;
    const prefix = DOCUMENT_TYPES[documentType]?.prefix || 'DOC';
    const docNo = `${prefix}-${order.order_no}-V${nextVersion}`;

    const { data: doc, error } = await (supabase.from('order_documents') as any)
      .insert({
        order_id: orderId,
        document_type: documentType,
        source_mode: 'ai_generated',
        version_no: nextVersion,
        status: 'draft',
        document_no: docNo,
        editable_json: parsed,
        created_by: user.id,
        is_current: true,
      })
      .select()
      .single();

    if (error) return { error: error.message };

    await logDocAction(supabase, doc.id, orderId, 'created', user.id, { source: 'ai_generated', documentType });

    revalidatePath(`/orders/${orderId}`);
    return { data: doc };
  } catch (err: any) {
    return { error: `AI生成失败: ${err.message}` };
  }
}

// ══════ 审批 ══════

export async function submitForReview(docId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { error } = await (supabase.from('order_documents') as any)
    .update({ status: 'pending_review', updated_by: user.id, updated_at: new Date().toISOString() })
    .eq('id', docId);

  if (error) return { error: error.message };

  const { data: doc } = await (supabase.from('order_documents') as any).select('order_id').eq('id', docId).single();
  if (doc) {
    await logDocAction(supabase, docId, doc.order_id, 'submitted', user.id);
    revalidatePath(`/orders/${doc.order_id}`);
  }
  return {};
}

export async function approveDocument(docId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // 获取单据信息
  const { data: doc } = await (supabase.from('order_documents') as any)
    .select('order_id, document_type, version_no')
    .eq('id', docId).single();
  if (!doc) return { error: '单据不存在' };

  // 权限校验：仅管理员和财务可审批
  const userIsAdmin = checkIsAdmin(user.email);
  if (!userIsAdmin) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, roles')
      .eq('user_id', user.id)
      .single();
    const roles: string[] = profile?.roles?.length > 0 ? profile.roles : [profile?.role].filter(Boolean);
    if (!roles.includes('finance') && !roles.includes('admin')) {
      return { error: '仅管理员或财务可以审批单据' };
    }
  }

  // 将同类型旧版本的 is_official 设为 false
  await (supabase.from('order_documents') as any)
    .update({ is_official: false })
    .eq('order_id', doc.order_id)
    .eq('document_type', doc.document_type)
    .neq('id', docId);

  // 审批当前版本
  const { error } = await (supabase.from('order_documents') as any)
    .update({
      status: 'approved',
      is_official: true,
      approved_by: user.id,
      approved_at: new Date().toISOString(),
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', docId);

  if (error) return { error: error.message };

  await logDocAction(supabase, docId, doc.order_id, 'approved', user.id);
  revalidatePath(`/orders/${doc.order_id}`);
  return {};
}

export async function rejectDocument(docId: string, reason: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { error } = await (supabase.from('order_documents') as any)
    .update({
      status: 'rejected',
      rejected_by: user.id,
      rejected_at: new Date().toISOString(),
      reject_reason: reason,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', docId);

  if (error) return { error: error.message };

  const { data: doc } = await (supabase.from('order_documents') as any).select('order_id').eq('id', docId).single();
  if (doc) {
    await logDocAction(supabase, docId, doc.order_id, 'rejected', user.id, { reason });
    revalidatePath(`/orders/${doc.order_id}`);
  }
  return {};
}

// ══════ 日志辅助 ══════

async function logDocAction(supabase: any, docId: string, orderId: string, action: string, userId: string, detail?: any) {
  await (supabase.from('document_logs') as any).insert({
    document_id: docId,
    order_id: orderId,
    action,
    actor_user_id: userId,
    detail: detail || null,
  }).catch(() => {});
}
