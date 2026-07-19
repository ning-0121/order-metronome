'use server';
import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { matchAccessory, parseAccessoryWorkbook } from '@/lib/parsers/accessory-import';

export async function importAccessoryCandidates(orderId: string, attachmentId: string, bytes: ArrayBuffer) {
  const sb = await createClient(); const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: '请先登录' };
  let parsed; try { parsed = await parseAccessoryWorkbook(bytes); } catch (e: unknown) { return { error: String(e instanceof Error ? e.message : '采购清单解析失败') }; }
  const { data: bom } = await sb
    .from('materials_bom')
    .select('id,material_code,material_name,spec,color,placement,unit,qty_per_piece,notes,special_requirements,sample_reference,position_description,image_urls,attachment_files')
    .eq('order_id', orderId);
  type AccessoryImportInsert = {
    order_id: string;
    source_attachment_id: string;
    source_row_number: number;
    matched_bom_id: string | null;
    parser_version: string;
    source_value: Record<string, unknown>;
    extracted_value: Record<string, unknown>;
    approved_value: null;
    missing_fields: string[];
    import_status: 'NEEDS_REVIEW' | 'MATCHED_TO_EXISTING' | 'NEW_ACCESSORY';
    created_by: string;
  };
  const seen = new Set<string>(); const inserts: AccessoryImportInsert[] = [];
  for (const row of parsed.rows) {
    const duplicate = seen.has(row.fingerprint); seen.add(row.fingerprint);
    const match = duplicate ? null : matchAccessory(row.normalized, bom || []);
    const diffFields = match?.fieldDiffs?.length ? match.fieldDiffs : [];
    const needsReview = duplicate || row.missingFields.length > 0 || diffFields.length > 0;
    inserts.push({ order_id: orderId, source_attachment_id: attachmentId, source_row_number: row.sourceRow,
      matched_bom_id: match?.id || null, parser_version: 'xlsx-accessory-v1', source_value: row.raw,
      extracted_value: { ...row.normalized, match_reason: match?.reason || null, match_confidence: match?.confidence || 0, duplicate_in_source: duplicate, difference_fields: diffFields },
      approved_value: null, missing_fields: duplicate ? [...row.missingFields, 'duplicate_in_source'] : row.missingFields,
      import_status: needsReview ? 'NEEDS_REVIEW' : match ? 'MATCHED_TO_EXISTING' : 'NEW_ACCESSORY', created_by: user.id });
  }
  if (!inserts.length) return { error: '文件中没有可导入的辅料行' };
  const { error } = await sb.from('accessory_import_candidates').insert(inserts);
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`); return { ok: true, count: inserts.length, worksheetName: parsed.worksheetName };
}

export async function listAccessoryCandidates(orderId: string, status?: string) {
  const sb = await createClient(); const { data: { user } } = await sb.auth.getUser(); if (!user) return { error: '请先登录' };
  let q = sb.from('accessory_import_candidates').select('*,order_attachments(file_name,file_url)').eq('order_id', orderId).order('source_row_number');
  if (status) q = q.eq('import_status', status); const { data, error } = await q; return error ? { error: error.message } : { data };
}

export async function reviewAccessoryCandidate(id: string, orderId: string, action: 'approve'|'exclude', approvedValue?: Record<string, unknown>, reason?: string) {
  const sb = await createClient(); const { data: { user } } = await sb.auth.getUser(); if (!user) return { error: '请先登录' };
  const { data: c } = await sb.from('accessory_import_candidates').select('*').eq('id', id).eq('order_id', orderId).single();
  if (!c) return { error: '候选行不存在或无权访问' };
  if (action === 'exclude') {
    const value = { ...(c.extracted_value || {}), exclusion_reason: String(reason || '人工排除').slice(0, 200) };
    const { error } = await sb.from('accessory_import_candidates').update({ import_status: 'EXCLUDED', approved_value: value, reviewed_by: user.id, updated_by: user.id, reviewed_at: new Date().toISOString() }).eq('id', id);
    return error ? { error: error.message } : { ok: true };
  }
  const value = { ...(c.extracted_value || {}), ...(approvedValue || {}) };
  if (!value.accessory_name || !value.unit || !(Number(value.unit_consumption) > 0)) return { error: '名称、单位和单耗必填' };
  let createdBomId: string | null = null;
  if (!c.matched_bom_id) {
    let duplicateQuery = sb.from('materials_bom').select('id').eq('order_id', orderId)
      .eq('material_name', value.accessory_name);
    duplicateQuery = value.specification
      ? duplicateQuery.eq('spec', value.specification)
      : duplicateQuery.is('spec', null);
    const { data: existing } = await duplicateQuery.limit(1).maybeSingle();
    if (existing) return { error: '发现同名同规格 BOM，请先选择已有物料，避免重复' };
    const { data: made, error: makeErr } = await sb.from('materials_bom').insert({ order_id: orderId, material_name: value.accessory_name,
      material_type: 'trim', material_code: value.accessory_code || null, spec: value.specification || null, color: value.color || null,
      placement: value.usage_position || null, position_description: value.position_description || null, unit: value.unit,
      qty_per_piece: Number(value.unit_consumption), consumption_basis: value.consumption_basis || null, created_by: user.id,
      source: 'file_parse', notes: value.notes || null, special_requirements: value.special_requirements || null,
      sample_reference: value.sample_reference || null, image_urls: Array.isArray(value.image_urls) ? value.image_urls : [],
      attachment_files: Array.isArray(value.attachment_files) ? value.attachment_files : [] }).select('id').single();
    if (makeErr) return { error: makeErr.message }; createdBomId = made.id;
  }
  const { error } = await sb.from('accessory_import_candidates').update({ import_status: 'APPROVED', approved_value: value,
    matched_bom_id: c.matched_bom_id || createdBomId, reviewed_by: user.id, updated_by: user.id, reviewed_at: new Date().toISOString() }).eq('id', id);
  if (error && createdBomId) await sb.from('materials_bom').delete().eq('id', createdBomId);
  revalidatePath(`/orders/${orderId}`); return error ? { error: error.message } : { ok: true };
}

export async function bulkApproveExactCandidates(orderId: string) {
  const sb = await createClient(); const { data: { user } } = await sb.auth.getUser(); if (!user) return { error: '请先登录' };
  const { data } = await sb.from('accessory_import_candidates').select('id,extracted_value,missing_fields')
    .eq('order_id', orderId).eq('import_status', 'MATCHED_TO_EXISTING');
  type AccessoryCandidateReviewRow = { id: string; extracted_value?: Record<string, unknown> | null; missing_fields?: string[] | null };
  const exact = ((data || []) as AccessoryCandidateReviewRow[]).filter((c) => !(c.missing_fields || []).length && c.extracted_value?.match_confidence === 1);
  let approved = 0; for (const c of exact) { const r = await reviewAccessoryCandidate(c.id, orderId, 'approve', c.extracted_value ?? undefined); if (!('error' in r)) approved++; }
  return { ok: true, approved };
}
