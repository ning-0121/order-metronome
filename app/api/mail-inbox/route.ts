import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { extractFromMail } from '@/lib/domain/mail-extract';
import type { CustomerMemoryCategory } from '@/lib/domain/customer-memory';
import { classifyRequirement } from '@/lib/domain/requirements';

/**
 * POST /api/mail-inbox
 * Body: { from_email, subject, raw_body?, received_at? }
 * Header: Authorization: Bearer <MAIL_INTAKE_SECRET>
 *
 * Ingests one email: extracts PO/style and category hints, links to order by PO, creates customer_memory from hints.
 */
export async function POST(request: Request) {
  const authHeader = request.headers.get('authorization');
  const secret = process.env.MAIL_INTAKE_SECRET;
  if (secret && authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { from_email?: string; subject?: string; raw_body?: string; received_at?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { from_email, subject, raw_body, received_at } = body;
  if (!from_email || !subject) {
    return NextResponse.json({ error: 'from_email and subject are required' }, { status: 400 });
  }

  let supabase;
  try {
    supabase = createServiceRoleClient();
  } catch (e) {
    console.error('Mail inbox: service role client init failed', e);
    return NextResponse.json(
      { error: 'Server misconfiguration: SUPABASE_SERVICE_ROLE_KEY required for mail intake' },
      { status: 503 }
    );
  }

  const receivedAt = received_at || new Date().toISOString();
  const extracted = extractFromMail(subject, raw_body || '');

  // Resolve order by PO (order_no)
  let order_id: string | null = null;
  let customer_id: string | null = null;
  if (extracted.extracted_po?.trim()) {
    const { data: order } = await (supabase.from('orders') as any)
      .select('id, order_no, customer_name')
      .eq('order_no', extracted.extracted_po.trim())
      .maybeSingle();
    if (order) {
      order_id = order.id;
      customer_id = order.customer_name || null;
    }
  }

  const { data: row, error: insertError } = await (supabase.from('mail_inbox') as any)
    .insert({
      from_email,
      subject,
      raw_body: raw_body || '',
      received_at: receivedAt,
      extracted_po: extracted.extracted_po || null,
      extracted_style: extracted.extracted_style || null,
      customer_id,
      order_id,
    })
    .select('id')
    .single();

  if (insertError) {
    console.error('Mail inbox insert error', insertError);
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

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

  return NextResponse.json({
    success: true,
    data: {
      mail_inbox_id,
      order_id,
      customer_id,
      extracted_po: extracted.extracted_po || null,
      extracted_style: extracted.extracted_style || null,
      memories_created,
    },
  });
}
