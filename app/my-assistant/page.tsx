import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { AgentChat } from '@/components/AgentChat';

export default async function MyAssistantPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await (supabase.from('profiles') as any)
    .select('name').eq('user_id', user.id).single();
  const userName = profile?.name || user.email?.split('@')[0];

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <AgentChat userName={userName} />
    </div>
  );
}
