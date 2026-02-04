import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { sendEmailNotification } from '@/lib/utils/notifications';
import { getCurrentUserRole, isAdmin } from '@/lib/utils/user-role';

/**
 * POST /api/nudge
 * Send nudge email to milestone owner
 * Rate limit: 1 nudge per milestone per hour
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user || !user.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check if user is admin
    if (!isAdmin(user.email)) {
      return NextResponse.json({ error: 'Only admin can nudge' }, { status: 403 });
    }

    const body = await request.json();
    const { milestone_id } = body;

    if (!milestone_id) {
      return NextResponse.json({ error: 'milestone_id is required' }, { status: 400 });
    }

    // Get milestone
    const { data: milestone, error: milestoneError } = await supabase
      .from('milestones')
      .select('*, orders!inner(id, order_no, customer_name, created_by)')
      .eq('id', milestone_id)
      .single();

    if (milestoneError || !milestone) {
      return NextResponse.json({ error: 'Milestone not found' }, { status: 404 });
    }

    const milestoneData = milestone as any;
    const orderData = milestoneData.orders;

    // Rate limit check: Check if nudge was sent in last hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recentNudges } = await supabase
      .from('milestone_logs')
      .select('id')
      .eq('milestone_id', milestone_id)
      .eq('action', 'nudge')
      .gte('created_at', oneHourAgo)
      .limit(1);

    if (recentNudges && recentNudges.length > 0) {
      return NextResponse.json(
        { error: 'Nudge already sent in the last hour. Please wait before nudging again.' },
        { status: 429 }
      );
    }

    // Get milestone owner email (fallback to order creator)
    let recipientEmail = '';
    let recipientName = '';

    if (milestoneData.owner_user_id) {
      const { data: ownerProfile } = await supabase
        .from('profiles')
        .select('email, name')
        .eq('user_id', milestoneData.owner_user_id)
        .single();
      if (ownerProfile) {
        recipientEmail = (ownerProfile as any).email || '';
        recipientName = (ownerProfile as any).name ?? (ownerProfile as any).email ?? '';
      }
    }

    if (!recipientEmail && orderData.created_by) {
      const { data: creatorProfile } = await supabase
        .from('profiles')
        .select('email, name')
        .eq('user_id', orderData.created_by)
        .single();
      if (creatorProfile) {
        recipientEmail = (creatorProfile as any).email || '';
        recipientName = (creatorProfile as any).name ?? (creatorProfile as any).email ?? '';
      }
    }

    // Final fallback to current user email
    if (!recipientEmail) {
      recipientEmail = user.email;
    }

    // Log nudge action
    await (supabase.from('milestone_logs') as any).insert({
      milestone_id: milestone_id,
      order_id: orderData.id,
      actor_user_id: user.id,
      action: 'nudge',
      note: `Nudge sent to ${recipientEmail}`,
      payload: { recipient_email: recipientEmail },
    });

    // Send email
    const ccEmails = ['su@qimoclothing.com', 'alex@qimoclothing.com'];
    const subject = `[Nudge] Action Required: ${milestoneData.name} - Order ${orderData.order_no}`;
    const html = `
      <h2>Action Required</h2>
      <p><strong>Order:</strong> ${orderData.order_no}</p>
      <p><strong>Customer:</strong> ${orderData.customer_name}</p>
      <p><strong>Milestone:</strong> ${milestoneData.name}</p>
      <p><strong>Due Date:</strong> ${milestoneData.due_at ? new Date(milestoneData.due_at).toLocaleDateString() : 'N/A'}</p>
      <p><strong>Status:</strong> ${milestoneData.status}</p>
      <p>Please take action on this milestone as soon as possible.</p>
      <p><a href="${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/orders/${orderData.id}#milestone-${milestone_id}">View Milestone</a></p>
    `;

    await sendEmailNotification([recipientEmail, ...ccEmails], subject, html);

    return NextResponse.json({
      success: true,
      message: 'Nudge sent successfully',
      recipient_email: recipientEmail,
    });
  } catch (error: any) {
    console.error('Error sending nudge:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
