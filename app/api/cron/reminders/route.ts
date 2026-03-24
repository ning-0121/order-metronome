import { checkAndSendReminders, checkDeliveryDeadlines } from '@/app/actions/notifications';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  // Verify cron secret if needed
  const authHeader = request.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const [reminderResult, deliveryResult] = await Promise.all([
      checkAndSendReminders(),
      checkDeliveryDeadlines(),
    ]);
    return NextResponse.json({
      success: true,
      reminders: reminderResult,
      delivery_alerts: deliveryResult,
    });
  } catch (error: any) {
    console.error('Cron job error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
