'use server';

import { createClient } from '@/lib/supabase/server';
import { generateSchedulingAdvice, type SchedulingAdvice } from '@/lib/agent/schedulingAdvice';

export async function getSchedulingAdvice(): Promise<{ data: SchedulingAdvice | null }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { data: null };
    const advice = await generateSchedulingAdvice(supabase);
    return { data: advice };
  } catch {
    return { data: null };
  }
}
