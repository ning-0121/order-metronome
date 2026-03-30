'use server';

import { createClient } from '@/lib/supabase/server';
import { extractFromMail } from '@/lib/domain/mail-extract';
import type { CustomerMemoryCategory } from '@/lib/domain/customer-memory';
import { classifyRequirement } from '@/lib/domain/requirements';

export interface MailInboxInsert {
  from_email: string;
  subject: string;
  raw_body: string;
  received_at?: string;
}

export interface IngestMailResult {
  mail_inbox_id: string;
  order_id: string | null;
  customer_id: string | null;
  extracted_po: string | null;
  extracted_style: string | null;
  memories_created: number;
  error?: string;
}

/**
 * Resolve order_id and customer_id from extracted PO (order_no) or style.
 * V1: match by order_no only (orders table has no style column).
 */
async function resolveOrderAndCustomer(
  supabase: any,
  extracted_po: string | null,
  _extracted_style: string | null
): Promise<{ order_id: string | null; customer_id: string | null }> {
  if (!extracted_po || !extracted_po.trim()) return { order_id: null, customer_id: null };

  const { data: order } = await (supabase.from('orders') as any)
    .select('id, order_no, customer_name')
    .eq('order_no', extracted_po.trim())
    .maybeSingle();

  if (order) return { order_id: order.id, customer_id: order.customer_name || null };
  return { order_id: null, customer_id: null };
}

/**
 * Ingest one email: store in mail_inbox, run extraction, auto-link to order, create customer_memory from category hints.
 * Call from API (e.g. webhook from Tencent Mail) or cron.
 */
export async function ingestMail(payload: MailInboxInsert): Promise<{ data?: IngestMailResult; error?: string }> {
  const supabase = await createClient();

  const { from_email, subject, raw_body } = payload;
  const received_at = payload.received_at || new Date().toISOString();

  if (!from_email || !subject) return { error: 'from_email and subject are required' };

  const extracted = extractFromMail(subject, raw_body || '');

  const { order_id, customer_id } = await resolveOrderAndCustomer(
    supabase,
    extracted.extracted_po,
    extracted.extracted_style
  );

  const { data: row, error: insertError } = await (supabase.from('mail_inbox') as any)
    .insert({
      from_email,
      subject,
      raw_body: raw_body || '',
      received_at,
      extracted_po: extracted.extracted_po || null,
      extracted_style: extracted.extracted_style || null,
      customer_id,
      order_id,
    })
    .select('id')
    .single();

  if (insertError) return { error: insertError.message };
  const mail_inbox_id = (row as { id: string }).id;

  let memories_created = 0;

  if (customer_id && extracted.categories.length > 0) {
    const categoryMap: Record<string, CustomerMemoryCategory> = {
      fabric_quality: 'fabric_quality',
      packaging: 'packaging',
      plus_size_stretch: 'plus_size_stretch',
    };

    for (const hint of extracted.categories) {
      const content = hint.quote || subject;
      const category = categoryMap[hint.category] ?? 'general';
      const req = classifyRequirement(content || `${subject}\n${raw_body || ''}`);

      const { error: memError } = await (supabase.from('customer_memory') as any).insert({
        customer_id,
        order_id,
        source_type: 'mail',
        content,
        category,
        risk_level: hint.risk_level,
        created_by: null,
        content_json: {
          original_quote: hint.quote,
          categories: [hint.category],
          mail_inbox_id,
          requirement_type: req.type,
          keywords_hit: req.keywordsHit,
          excerpt: req.excerpt,
        },
      });

      if (!memError) memories_created += 1;
    }
  }

  return {
    data: {
      mail_inbox_id,
      order_id,
      customer_id,
      extracted_po: extracted.extracted_po || null,
      extracted_style: extracted.extracted_style || null,
      memories_created,
    },
  };
}
