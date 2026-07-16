'use server';
import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { matchAccessory, parseAccessoryWorkbook } from '@/lib/parsers/accessory-import';

export async function importAccessoryCandidates(orderId: string, attachmentId: string, bytes: ArrayBuffer) {
  const sb = await createClient(); const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: '请先登录' };
  let parsed; try { parsed = await parseAccessoryWorkbook(bytes); } catch (e: any) { return { error: String(e?.message || '采购清单解析失败') }; }
  const { data: bom } = await (sb.from('materials_bom') as any).select('id,material_code,material_name,spec,color,placement').eq('order_id', orderId);
  const seen = new Set<string>(); const inserts: any[] = [];
  for (const row of parsed.rows) {
    const duplicate = seen.has(row.fingerprint); seen.add(row.fingerprint);
    const match = duplicate ? null : matchAccessory(row.normalized, bom || []);
    inserts.push({ order_id: orderId, source_attachment_id: attachmentId, source_row_number: row.sourceRow,
      matched_bom_id: match?.id || null, parser_version: 'xlsx-accessory-v1', source_value: row.raw,
      extracted_value: { ...row.normalized, match_reason: match?.reason || null, match_confidence: match?.confidence || 0, duplicate_in_source: duplicate },
      approved_value: null, missing_fields: duplicate ? [...row.missingFields, 'duplicate_in_source'] : row.missingFields,
      import_status: duplicate || row.missingFields.length ? 'NEEDS_REVIEW' : match ? 'MATCHED_TO_EXISTING' : 'NEW_ACCESSORY', created_by: user.id });
  }
  if (!inserts.length) return { error: '文件中没有可导入的辅料行' };
  const { error } = await (sb.from('accessory_import_candidates') as any).insert(inserts);
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`); return { ok: true, count: inserts.length, worksheetName: parsed.worksheetName };
}

export async function listAccessoryCandidates(orderId: string, status?: string) {
  const sb = await createClient(); const { data: { user } } = await sb.auth.getUser(); if (!user) return { error: '请先登录' };
  let q = (sb.from('accessory_import_candidates') as any).select('*,order_attachments(file_name,file_url)').eq('order_id', orderId).order('source_row_number');
  if (status) q = q.eq('import_status', status); const { data, error } = await q; return error ? { error: error.message } : { data };
}

export async function reviewAccessoryCandidate(id: string, orderId: string, action: 'approve'|'exclude', approvedValue?: any, reason?: string) {
  const sb = await createClient(); const { data: { user } } = await sb.auth.getUser(); if (!user) return { error: '请先登录' };
  const { data: c } = await (sb.from('accessory_import_candidates') as any).select('*').eq('id', id).eq('order_id', orderId).single();
  if (!c) return { error: '候选行不存在或无权访问' };
  if (action === 'exclude') {
    const value = { ...(c.extracted_value || {}), exclusion_reason: String(reason || '人工排除').slice(0, 200) };
    const { error } = await (sb.from('accessory_import_candidates') as any).update({ import_status: 'EXCLUDED', approved_value: value, reviewed_by: user.id, updated_by: user.id, reviewed_at: new Date().toISOString() }).eq('id', id);
    return error ? { error: error.message } : { ok: true };
  }
  const value = { ...(c.extracted_value || {}), ...(approvedValue || {}) };
  if (!value.accessory_name || !value.unit || !(Number(value.unit_consumption) > 0)) return { error: '名称、单位和单耗必填' };
  let createdBomId: string | null = null;
  if (!c.matched_bom_id) {
    let duplicateQuery = (sb.from('materials_bom') as any).select('id').eq('order_id', orderId)
      .eq('material_name', value.accessory_name);
    duplicateQuery = value.specification
      ? duplicateQuery.eq('spec', value.specification)
      : duplicateQuery.is('spec', null);
    const { data: existing } = await duplicateQuery.limit(1).maybeSingle();
    if (existing) return { error: '发现同名同规格 BOM，请先选择已有物料，避免重复' };
    const { data: made, error: makeErr } = await (sb.from('materials_bom') as any).insert({ order_id: orderId, material_name: value.accessory_name,
      material_type: 'trim', material_code: value.accessory_code || null, spec: value.specification || null, color: value.color || null,
      placement: value.usage_position || null, position_description: value.position_description || null, unit: value.unit,
      qty_per_piece: Number(value.unit_consumption), consumption_basis: value.consumption_basis || null, created_by: user.id, source: 'file_parse' }).select('id').single();
    if (makeErr) return { error: makeErr.message }; createdBomId = made.id;
  }
  const { error } = await (sb.from('accessory_import_candidates') as any).update({ import_status: 'APPROVED', approved_value: value,
    matched_bom_id: c.matched_bom_id || createdBomId, reviewed_by: user.id, updated_by: user.id, reviewed_at: new Date().toISOString() }).eq('id', id);
  if (error && createdBomId) await (sb.from('materials_bom') as any).delete().eq('id', createdBomId);
  revalidatePath(`/orders/${orderId}`); return error ? { error: error.message } : { ok: true };
}

export async function bulkApproveExactCandidates(orderId: string) {
  const sb = await createClient(); const { data: { user } } = await sb.auth.getUser(); if (!user) return { error: '请先登录' };
  const { data } = await (sb.from('accessory_import_candidates') as any).select('id,extracted_value,missing_fields')
    .eq('order_id', orderId).eq('import_status', 'MATCHED_TO_EXISTING');
  const exact = (data || []).filter((c: any) => !(c.missing_fields || []).length && c.extracted_value?.match_confidence === 1);
  let approved = 0; for (const c of exact) { const r = await reviewAccessoryCandidate(c.id, orderId, 'approve', c.extracted_value); if (!(r as any).error) approved++; }
  return { ok: true, approved };
}
