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

