'use server';

import { createClient } from '@/lib/supabase/server';
import type { CustomerMemoryCategory, CustomerMemoryRiskLevel, CustomerMemorySourceType } from '@/lib/domain/customer-memory';
import { getTopRelevantMemories } from '@/lib/domain/customer-memory';

export interface CreateCustomerMemoryInput {
  customer_id: string;
  order_id?: string | null;
  source_type: CustomerMemorySourceType;
  content: string;
  category?: CustomerMemoryCategory;
  risk_level?: CustomerMemoryRiskLevel;
  content_json?: Record<string, unknown> | null;
}

/**
 * Create a customer memory record. Used by auto-hooks and manual "save as memory".
 */
export async function createCustomerMemory(input: CreateCustomerMemoryInput): Promise<{ data?: { id: string }; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized' };

  const { error } = await (supabase.from('customer_memory') as any).insert({
    customer_id: input.customer_id,
    order_id: input.order_id ?? null,
    source_type: input.source_type,
    content: input.content,
    category: input.category ?? 'general',
    risk_level: input.risk_level ?? 'medium',
    created_by: user.id,
    content_json: input.content_json ?? null,
  });

  if (error) return { error: error.message };
  return { data: { id: '' } };
}

/**
 * Get memory records for a customer (V1: customer_id = customer_name).
 * Ordered by created_at desc, limit 50 for UI.
 */
export async function getCustomerMemoryByCustomer(customerId: string): Promise<{ data: any[] | null; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: 'Unauthorized' };

  const { data, error } = await (supabase.from('customer_memory') as any)
    .select('id, customer_id, order_id, source_type, content, category, risk_level, created_at, content_json')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return { data: null, error: error.message };
  return { data: data ?? [] };
}

/**
 * V1.1: Return top 3 memories relevant to the given context (order/milestone/delay text).
 * Uses keyword matching; HIGH risk first, then MEDIUM; then category-keyword match.
 */
export async function getRelevantCustomerMemory(
  customerName: string,
  contextString: string
): Promise<{ data: any[] | null; error?: string }> {
  const { data, error } = await getCustomerMemoryByCustomer(customerName);
  if (error || !data) return { data: null, error: error ?? undefined };
  const top = getTopRelevantMemories(data, contextString, 3);
  return { data: top };
}
