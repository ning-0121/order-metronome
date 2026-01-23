'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export interface Attachment {
  id: string;
  milestone_id: string;
  order_id: string;
  url: string;
  file_name: string | null;
  file_type: string | null;
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
 */
export async function uploadEvidence(
  milestoneId: string,
  orderId: string,
  file: File
): Promise<{ data: Attachment | null; error: string | null }> {
  const supabase = await createClient();
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { data: null, error: 'Not authenticated' };
  }
  
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
  
  // Create attachment record
  const { data: attachment, error: insertError } = await (supabase
    .from('attachments') as any)
    .insert({
      milestone_id: milestoneId,
      order_id: orderId,
      url: publicUrl,
      file_name: file.name,
      file_type: file.type || fileExt || null,
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
  await logEvidenceUpload(milestoneId, orderId, file.name);
  
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
 * Check if milestone has required evidence
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
