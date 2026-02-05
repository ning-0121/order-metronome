'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import {
  getRequiredDocsForStep,
  validateRequiredDocs,
  type DocumentType,
} from '@/lib/domain/required-documents';

export interface Attachment {
  id: string;
  milestone_id: string;
  order_id: string;
  url: string;
  file_name: string | null;
  file_type: string | null;
  doc_type: string | null;
  required_for_step_key: string | null;
  uploaded_by: string | null;
  created_at: string;
}

/**
 * Get attachments for a milestone
 */
export async function getAttachmentsByMilestone(milestoneId: string) {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('attachments')
    .select('*')
    .eq('milestone_id', milestoneId)
    .order('created_at', { ascending: false });

  if (error) {
    return { error: error.message, data: null };
  }

  return { data: data as Attachment[], error: null };
}

/**
 * Get attachments for an order
 */
export async function getAttachmentsByOrder(orderId: string) {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('attachments')
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });

  if (error) {
    return { error: error.message, data: null };
  }

  return { data: data as Attachment[], error: null };
}

/**
 * Upload file to Supabase Storage and create attachment record
 * Now supports doc_type classification
 */
export async function uploadEvidence(
  milestoneId: string,
  orderId: string,
  file: File,
  docType?: DocumentType | string
): Promise<{ data: Attachment | null; error: string | null }> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { data: null, error: 'Not authenticated' };
  }

  // Get milestone step_key for required_for_step_key
  const { data: milestone } = await (supabase
    .from('milestones') as any)
    .select('step_key')
    .eq('id', milestoneId)
    .single();

  const stepKey = milestone?.step_key || null;

  // Generate unique file path
  const fileExt = file.name.split('.').pop();
  const fileName = `${milestoneId}/${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
  const filePath = `evidence/${fileName}`;

  // Upload to Supabase Storage
  const { data: uploadData, error: uploadError } = await supabase.storage
    .from('evidence')
    .upload(filePath, file, {
      cacheControl: '3600',
      upsert: false,
    });

  if (uploadError) {
    return { data: null, error: `Upload failed: ${uploadError.message}` };
  }

  // Get public URL
  const { data: { publicUrl } } = supabase.storage
    .from('evidence')
    .getPublicUrl(filePath);

  // Create attachment record with doc_type
  const { data: attachment, error: insertError } = await (supabase
    .from('attachments') as any)
    .insert({
      milestone_id: milestoneId,
      order_id: orderId,
      url: publicUrl,
      file_name: file.name,
      file_type: file.type || fileExt || null,
      doc_type: docType || null,
      required_for_step_key: stepKey,
      uploaded_by: user.id,
    })
    .select()
    .single();

  if (insertError) {
    // Clean up uploaded file if insert fails
    await supabase.storage.from('evidence').remove([filePath]);
    return { data: null, error: `Failed to create attachment record: ${insertError.message}` };
  }

  revalidatePath(`/orders/${orderId}`);

  // Log evidence upload action
  const { logEvidenceUpload } = await import('./milestones');
  const logNote = docType ? `${file.name} (${docType})` : file.name;
  await logEvidenceUpload(milestoneId, orderId, logNote);

  return { data: attachment as Attachment, error: null };
}

/**
 * Delete attachment
 */
export async function deleteAttachment(attachmentId: string, orderId: string) {
  const supabase = await createClient();

  // Get attachment to get file path
  const { data: attachment, error: fetchError } = await (supabase
    .from('attachments') as any)
    .select('url')
    .eq('id', attachmentId)
    .single();

  if (fetchError || !attachment) {
    return { error: 'Attachment not found' };
  }

  // Extract file path from URL
  const attachmentData = attachment as { url: string };
  const url = new URL(attachmentData.url);
  const filePath = url.pathname.split('/storage/v1/object/public/evidence/')[1];

  // Delete from storage
  if (filePath) {
    await supabase.storage.from('evidence').remove([filePath]);
  }

  // Delete attachment record
  const { error: deleteError } = await (supabase
    .from('attachments') as any)
    .delete()
    .eq('id', attachmentId);

  if (deleteError) {
    return { error: deleteError.message };
  }

  revalidatePath(`/orders/${orderId}`);

  return { error: null };
}

/**
 * Check if milestone has required evidence (legacy - simple check)
 */
export async function checkMilestoneEvidence(milestoneId: string) {
  const supabase = await createClient();

  // Get milestone to check evidence_required
  const { data: milestone, error: milestoneError } = await (supabase
    .from('milestones') as any)
    .select('evidence_required')
    .eq('id', milestoneId)
    .single();

  if (milestoneError || !milestone) {
    return { hasEvidence: false, error: 'Milestone not found' };
  }

  const milestoneData = milestone as { evidence_required: boolean };

  if (!milestoneData.evidence_required) {
    return { hasEvidence: true, error: null };
  }

  // Check if attachments exist
  const { data: attachments, error: attachmentsError } = await (supabase
    .from('attachments') as any)
    .select('id')
    .eq('milestone_id', milestoneId)
    .limit(1);

  if (attachmentsError) {
    return { hasEvidence: false, error: attachmentsError.message };
  }

  return { hasEvidence: (attachments?.length || 0) > 0, error: null };
}

/**
 * Check required documents for a milestone (V1 evidence gate)
 * Returns validation result with missing document types
 */
export async function checkRequiredDocuments(milestoneId: string): Promise<{
  isValid: boolean;
  missingDocs: string[];
  uploadedDocs: { docType: string; count: number }[];
  error: string | null;
}> {
  const supabase = await createClient();

  // Get milestone step_key
  const { data: milestone, error: milestoneError } = await (supabase
    .from('milestones') as any)
    .select('step_key')
    .eq('id', milestoneId)
    .single();

  if (milestoneError || !milestone) {
    return { isValid: false, missingDocs: [], uploadedDocs: [], error: 'Milestone not found' };
  }

  const stepKey = milestone.step_key;
  const requiredDocs = getRequiredDocsForStep(stepKey);

  // If no required docs defined for this step, it's valid
  if (requiredDocs.length === 0) {
    return { isValid: true, missingDocs: [], uploadedDocs: [], error: null };
  }

  // Get attachments for this milestone
  const { data: attachments, error: attachmentsError } = await (supabase
    .from('attachments') as any)
    .select('doc_type')
    .eq('milestone_id', milestoneId);

  if (attachmentsError) {
    return { isValid: false, missingDocs: [], uploadedDocs: [], error: attachmentsError.message };
  }

  // Extract uploaded doc types
  const uploadedDocTypes = (attachments || []).map((a: any) => a.doc_type);

  // Validate against requirements
  const validation = validateRequiredDocs(stepKey, uploadedDocTypes);

  // Count uploaded docs by type
  const docTypeCounts: Record<string, number> = {};
  uploadedDocTypes.forEach((dt: string | null) => {
    if (dt) {
      docTypeCounts[dt] = (docTypeCounts[dt] || 0) + 1;
    }
  });

  const uploadedDocs = Object.entries(docTypeCounts).map(([docType, count]) => ({
    docType,
    count,
  }));

  return {
    isValid: validation.isValid,
    missingDocs: validation.missingDocs,
    uploadedDocs,
    error: null,
  };
}

/**
 * Get required documents status for a milestone
 * Used by UI to show which documents are required and which are uploaded
 */
export async function getRequiredDocumentsStatus(milestoneId: string): Promise<{
  stepKey: string;
  requiredDocs: string[];
  optionalDocs: string[];
  uploadedDocs: { docType: string; fileName: string; id: string }[];
  missingDocs: string[];
  isComplete: boolean;
  error: string | null;
}> {
  const supabase = await createClient();

  // Get milestone step_key
  const { data: milestone, error: milestoneError } = await (supabase
    .from('milestones') as any)
    .select('step_key')
    .eq('id', milestoneId)
    .single();

  if (milestoneError || !milestone) {
    return {
      stepKey: '',
      requiredDocs: [],
      optionalDocs: [],
      uploadedDocs: [],
      missingDocs: [],
      isComplete: true,
      error: 'Milestone not found',
    };
  }

  const stepKey = milestone.step_key;

  // Import helper functions
  const { getOptionalDocsForStep } = await import('@/lib/domain/required-documents');

  const requiredDocs = getRequiredDocsForStep(stepKey);
  const optionalDocs = getOptionalDocsForStep(stepKey);

  // Get attachments for this milestone
  const { data: attachments, error: attachmentsError } = await (supabase
    .from('attachments') as any)
    .select('id, doc_type, file_name')
    .eq('milestone_id', milestoneId);

  if (attachmentsError) {
    return {
      stepKey,
      requiredDocs,
      optionalDocs,
      uploadedDocs: [],
      missingDocs: requiredDocs,
      isComplete: requiredDocs.length === 0,
      error: attachmentsError.message,
    };
  }

  // Map uploaded docs
  const uploadedDocs = (attachments || [])
    .filter((a: any) => a.doc_type)
    .map((a: any) => ({
      docType: a.doc_type,
      fileName: a.file_name || 'Unknown',
      id: a.id,
    }));

  // Find missing required docs
  const uploadedDocTypes = new Set(uploadedDocs.map((d: { docType: string }) => d.docType));
  const missingDocs = requiredDocs.filter((dt: string) => !uploadedDocTypes.has(dt));

  return {
    stepKey,
    requiredDocs,
    optionalDocs,
    uploadedDocs,
    missingDocs,
    isComplete: missingDocs.length === 0,
    error: null,
  };
}
