import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { isAdmin } = await getCurrentUserRole(supabase);

  // Admin → CEO War Room（决策视图）
  // 员工 → /my-today（执行视图）
  redirect(isAdmin ? '/ceo-war-room' : '/my-today');
}
