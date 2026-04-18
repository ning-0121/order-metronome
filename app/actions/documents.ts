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

  // ── 尝试读取 PO 提取缓存（一次提取，多次复用）──────────────────────────
  let poData: any = null;
  try {
    const { getOrderExtraction } = await import('@/app/actions/po-extract');
    poData = await getOrderExtraction(orderId, 'customer_po');
  } catch {}

  const today = new Date().toISOString().slice(0, 10);
  const currency = poData?.header?.currency || 'USD';
  const poNumber = poData?.header?.po_number || order.po_number || '';

  // 从 PO 提取数据构建行项目（如有）；否则用订单基本信息生成占位
  const lineItemsFromPO = poData?.line_items?.map((item: any, idx: number) => ({
    line_no: idx + 1,
    style_no: item.style_no || order.style_no || '',
    description: item.description || '',
    color: item.color || '',
    sizes: item.sizes || {},
    quantity: item.total_quantity || order.quantity,
    unit_price: 0,   // 价格由业务手动填写，AI 不填
    amount: 0,
  })) || [{
    line_no: 1,
    style_no: order.style_no || '',
    description: order.customer_name || '',
    color: '',
    sizes: {},
    quantity: order.quantity,
    unit_price: 0,
    amount: 0,
  }];

  const packagingInfo = poData?.packaging_requirements
    ? Object.entries(poData.packaging_requirements)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
    : '';
  const productionNotes = poData?.production_notes?.join('\n') || '';
  const qualityReqs = poData?.quality_requirements?.join('\n') || '';

  const prompts: Record<string, string> = {
    pi: `根据以下信息生成标准 Proforma Invoice（PI）草稿，严格遵循正规外贸单据格式。
以下数据均来自系统，不要修改，直接填入：
- 卖方（Seller）: ${COMPANY_INFO.name_en}, ${COMPANY_INFO.address}
- 买方（Buyer）: ${order.customer_name}
- PI编号（PI No.）: PI-${order.order_no}
- 日期（Date）: ${today}
- PO号: ${poNumber}
- 贸易条款（Trade Terms）: ${order.incoterm}
- 装货港（Port of Loading）: 广州, CHINA
- 目的港（Port of Destination）: 根据incoterm和客户位置推断，如不确定填空
- 付款条款（Payment Terms）: T/T 30% DEPOSIT, BALANCE BEFORE SHIPMENT（可留空由业务修改）
- 货币（Currency）: ${currency}
- 出运日期（Shipment Date）: ${order.etd || order.factory_date || ''}
- 行项目：${JSON.stringify(lineItemsFromPO)}

返回JSON（unit_price和amount填0，由业务核对后填写）：
{"pi_no":"PI-${order.order_no}","date":"${today}","seller":{"name":"${COMPANY_INFO.name_en}","address":"${COMPANY_INFO.address}"},"buyer":"${order.customer_name}","po_no":"${poNumber}","currency":"${currency}","trade_terms":"${order.incoterm}","payment_terms":"T/T 30% DEPOSIT, BALANCE BEFORE SHIPMENT","port_of_loading":"GUANGZHOU, CHINA","port_of_destination":"","shipment_date":"${order.etd || ''}","items":${JSON.stringify(lineItemsFromPO.map(i => ({...i, unit_price:0, amount:0})))},"subtotal":0,"freight":0,"total":0,"bank_info":{"bank_name":"","account_no":"","swift_code":""},"remarks":""}`,

    production_sheet: `根据以下信息生成完整生产单草稿JSON，包含所有必要字段。
订单信息：
- 订单号: ${order.order_no} | 客户: ${order.customer_name} | 工厂: ${order.factory_name || ''}
- PO号: ${poNumber} | 数量: ${order.quantity}件 | 出厂日: ${order.factory_date || ''}
- 贸易条款: ${order.incoterm} | 订单类型: ${order.order_type}
PO行项目: ${JSON.stringify(lineItemsFromPO)}
包装要求（来自PO，如有）: ${packagingInfo}
生产注意事项（来自PO，如有）: ${productionNotes}
品质要求（来自PO，如有）: ${qualityReqs}

返回JSON：{"po_no":"${poNumber}","internal_no":"${order.order_no}","customer":"${order.customer_name}","factory":"${order.factory_name || ''}","quantity":${order.quantity},"delivery_date":"${order.factory_date || ''}","etd":"${order.etd || ''}","line_items":${JSON.stringify(lineItemsFromPO)},"fabric_requirements":"","color_breakdown":"${lineItemsFromPO.map((i:any)=>i.color).filter(Boolean).join(' / ')}","size_breakdown":${JSON.stringify(lineItemsFromPO.map((i:any) => ({style: i.style_no, color: i.color, sizes: i.sizes})))},"craft_requirements":"","packing_requirements":"${packagingInfo.replace(/"/g, '\\"')}","production_notes":"${productionNotes.replace(/"/g, '\\"')}","quality_requirements":"${qualityReqs.replace(/"/g, '\\"')}","trims":"","special_notes":""}`,

    packing_list: `根据以下信息生成装箱单草稿JSON，装箱方案由业务根据实际装箱情况填写。
- 订单号: ${order.order_no} | 客户: ${order.customer_name} | 总件数: ${order.quantity}件
- 出运日期: ${order.etd || ''} | 贸易条款: ${order.incoterm}
- 行项目（颜色/尺码参考）: ${JSON.stringify(lineItemsFromPO)}
- 包装规格（来自PO）: ${packagingInfo}

返回JSON（carton_count、sizes等数字暂填0或空，业务完成装箱后填写）：{"pl_no":"PL-${order.order_no}","date":"${today}","customer":"${order.customer_name}","po_no":"${poNumber}","items":${JSON.stringify(lineItemsFromPO.map((i:any,idx:number)=>({line_no:idx+1,style_no:i.style_no,color:i.color,size_breakdown:i.sizes,qty_per_carton:0,carton_count:0,total_qty:i.quantity,carton_size:"",nw_per_carton:0,gw_per_carton:0,cbm:0})))},"total_cartons":0,"total_qty":${order.quantity},"total_nw":0,"total_gw":0,"total_cbm":0,"marks":"CARTON NO. 1-UP\\n${order.customer_name}\\n${poNumber}\\nMADE IN CHINA","remarks":""}`,

    ci: `根据以下信息生成标准 Commercial Invoice（CI）草稿，所有价格字段填0由业务在审批时填写。
- 卖方: ${COMPANY_INFO.name_en}, ${COMPANY_INFO.address}
- 买方: ${order.customer_name}
- CI编号: CI-${order.order_no}
- 日期: ${today}
- PO号: ${poNumber}
- 贸易条款: ${order.incoterm}
- 货币: ${currency}
- 行项目: ${JSON.stringify(lineItemsFromPO)}

返回JSON：{"ci_no":"CI-${order.order_no}","date":"${today}","seller":{"name":"${COMPANY_INFO.name_en}","address":"${COMPANY_INFO.address}"},"buyer":"${order.customer_name}","po_no":"${poNumber}","currency":"${currency}","trade_terms":"${order.incoterm}","port_of_loading":"GUANGZHOU, CHINA","port_of_destination":"","vessel_voyage":"","bl_no":"","items":${JSON.stringify(lineItemsFromPO.map((i:any)=>({...i,unit_price:0,amount:0})))},"total_qty":${order.quantity},"total_amount":0,"hs_code":"","country_of_origin":"CHINA","remarks":""}`,
  };

  const prompt = prompts[documentType];
  if (!prompt) return { error: `暂不支持AI生成 ${documentType}` };

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: `你是外贸单据专家，擅长生成标准、规范的外贸单据。
规则：
1. 只返回 JSON，不加 markdown 包装
2. 价格/金额字段统一填 0（由业务审核时填写）
3. 字段值使用系统提供的真实数据，不编造
4. 格式要规范，符合国际贸易惯例
5. 中文注意事项字段保留原文，英文字段用英文`,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content.filter(b => b.type === 'text').map(b => (b as Anthropic.TextBlock).text).join('');
    let jsonStr = text.trim();
    if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

    let parsed: any;
    try { parsed = JSON.parse(jsonStr); } catch { return { error: 'AI 返回格式异常，请重试' }; }

    // 追加 PO 提取元数据到生成结果（用于审核页面展示数据来源）
    if (poData) {
      parsed._po_source = {
        po_number: poData.header?.po_number,
        confidence: poData.extraction_meta?.confidence,
        note: 'LINE ITEMS PRE-FILLED FROM PO EXTRACTION — PLEASE VERIFY UNIT PRICES BEFORE APPROVING',
      };
    }

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

    // 查找最新 extraction_id（用于记录数据来源）
    let extractionId: string | null = null;
    try {
      const { data: ext } = await (supabase.from('document_extractions') as any)
        .select('id').eq('order_id', orderId)
        .in('review_status', ['confirmed', 'modified', 'pending_review'])
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      extractionId = ext?.id || null;
    } catch {}

    const { data: doc, error } = await (supabase.from('order_documents') as any)
      .insert({
        order_id: orderId,
        document_type: documentType,
        source_mode: 'ai_generated',
        version_no: nextVersion,
        status: 'draft',
        document_no: docNo,
        editable_json: parsed,
        extraction_id: extractionId,
        template_version: 'v2',
        created_by: user.id,
        is_current: true,
      })
      .select()
      .single();

    if (error) return { error: error.message };

    // 标记 PO 提取已用于 PI/CI 生成
    if (extractionId) {
      await (supabase.from('document_extractions') as any)
        .update({ used_for_pi_ci: true })
        .eq('id', extractionId);
    }

    await logDocAction(supabase, doc.id, orderId, 'created', user.id, {
      source: 'ai_generated',
      documentType,
      po_data_used: !!poData,
      template_version: 'v2',
    });

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

  // 权限检查：仅管理员或财务可驳回
  const { data: profile } = await supabase.from('profiles').select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  if (!roles.includes('admin') && !roles.includes('finance')) {
    return { error: '仅管理员或财务可以驳回单据' };
  }

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
  });
}
