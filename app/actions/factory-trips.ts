'use server';

/**
 * 出车行程 + 捎带共享(2026-07-27 CEO)——按日程规划去哪些工厂,共享到系统,别人可挂"帮带东西"。
 * 导航靠工厂地址生成高德/百度深链(手机点开即导航,免地图 SDK)。只读页 + 轻写操作。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export interface TripFactory { id: string; name: string; city: string | null; address: string | null; }
export interface Piggyback { id: string; item: string; to_factory_name: string | null; note: string | null; requester_name: string | null; status: string; }
export interface Trip {
  id: string; trip_date: string; creator_name: string | null; note: string | null; status: string;
  factories: TripFactory[]; piggybacks: Piggyback[]; mine: boolean;
}
export interface DueFactory { factory_id: string | null; factory_name: string; nodeCount: number; nearestDue: string | null; }

export interface TripsBoard {
  trips: Trip[];
  allFactories: TripFactory[];
  dueFactories: DueFactory[];   // 未来 14 天有到期节点的工厂(建议去跑)
  error?: string;
}

export async function getTripsBoard(): Promise<TripsBoard> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { trips: [], allFactories: [], dueFactories: [], error: '请先登录' };
  const svc = createServiceRoleClient();

  const [{ data: facs }, { data: tripRows }] = await Promise.all([
    (svc.from('factories') as any).select('id, factory_name, city, address').is('deleted_at', null).order('factory_name'),
    (svc.from('factory_trips') as any).select('*').neq('status', 'cancelled')
      .gte('trip_date', new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10))
      .order('trip_date', { ascending: true }).limit(100),
  ]);
  const allFactories: TripFactory[] = ((facs || []) as any[]).map((f) => ({ id: f.id, name: f.factory_name, city: f.city, address: f.address }));
  const facMap = new Map(allFactories.map((f) => [f.id, f]));

  // 捎带
  const trips = (tripRows || []) as any[];
  const tripIds = trips.map((t) => t.id);
  const pbByTrip = new Map<string, Piggyback[]>();
  if (tripIds.length) {
    const { data: pbs } = await (svc.from('trip_piggyback') as any).select('*').in('trip_id', tripIds).order('created_at');
    for (const p of ((pbs || []) as any[])) {
      const arr = pbByTrip.get(p.trip_id) || [];
      arr.push({ id: p.id, item: p.item, to_factory_name: p.to_factory_name, note: p.note, requester_name: p.requester_name, status: p.status });
      pbByTrip.set(p.trip_id, arr);
    }
  }

  const tripsOut: Trip[] = trips.map((t) => ({
    id: t.id, trip_date: t.trip_date, creator_name: t.creator_name, note: t.note, status: t.status,
    factories: ((t.factory_ids || []) as string[]).map((id) => facMap.get(id)).filter(Boolean) as TripFactory[],
    piggybacks: pbByTrip.get(t.id) || [],
    mine: t.created_by === user.id,
  }));

  // 未来 14 天有到期节点的工厂(按日程建议去跑)
  const dueFactories: DueFactory[] = [];
  try {
    const now = new Date();
    const end = new Date(now.getTime() + 14 * 86400000);
    const { data: ms } = await (svc.from('milestones') as any)
      .select('due_at, order_id')
      .gte('due_at', now.toISOString()).lt('due_at', end.toISOString())
      .not('status', 'in', '("done","completed","已完成","cancelled","已取消")').limit(1000);
    const orderIds = Array.from(new Set(((ms || []) as any[]).map((m) => m.order_id)));
    const ordFac = new Map<string, { id: string | null; name: string }>();
    for (let i = 0; i < orderIds.length; i += 300) {
      const { data: os } = await (svc.from('orders') as any).select('id, factory_id, factory_name').in('id', orderIds.slice(i, i + 300));
      for (const o of ((os || []) as any[])) ordFac.set(o.id, { id: o.factory_id || null, name: o.factory_name || '(未指定工厂)' });
    }
    const agg = new Map<string, DueFactory>();
    for (const m of ((ms || []) as any[])) {
      const f = ordFac.get(m.order_id); if (!f) continue;
      const key = f.id || f.name;
      const cur = agg.get(key) || { factory_id: f.id, factory_name: f.name, nodeCount: 0, nearestDue: null };
      cur.nodeCount++;
      const d = String(m.due_at).slice(0, 10);
      if (!cur.nearestDue || d < cur.nearestDue) cur.nearestDue = d;
      agg.set(key, cur);
    }
    dueFactories.push(...[...agg.values()].sort((a, b) => (a.nearestDue || '').localeCompare(b.nearestDue || '')));
  } catch { /* 建议区失败不影响主功能 */ }

  return { trips: tripsOut, allFactories, dueFactories };
}

async function actorName(supabase: any, userId: string): Promise<string> {
  const { data } = await supabase.from('profiles').select('name, email').eq('user_id', userId).maybeSingle();
  return (data as any)?.name || (data as any)?.email?.split('@')[0] || '同事';
}

export async function createTrip(tripDate: string, factoryIds: string[], note: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '请先登录' };
  if (!tripDate) return { ok: false, error: '请选日期' };
  if (!factoryIds?.length) return { ok: false, error: '请至少选一家工厂' };
  const svc = createServiceRoleClient();
  const { error } = await (svc.from('factory_trips') as any).insert({
    trip_date: tripDate, created_by: user.id, creator_name: await actorName(supabase, user.id),
    factory_ids: factoryIds, note: note?.trim() || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/production/trips');
  return { ok: true };
}

export async function cancelTrip(tripId: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '请先登录' };
  const svc = createServiceRoleClient();
  const { error } = await (svc.from('factory_trips') as any).update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', tripId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/production/trips');
  return { ok: true };
}

export async function addPiggyback(tripId: string, item: string, toFactoryId: string | null, toFactoryName: string | null, note: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '请先登录' };
  if (!item?.trim()) return { ok: false, error: '请填要带的东西' };
  const svc = createServiceRoleClient();
  const { error } = await (svc.from('trip_piggyback') as any).insert({
    trip_id: tripId, requester_id: user.id, requester_name: await actorName(supabase, user.id),
    item: item.trim(), to_factory_id: toFactoryId, to_factory_name: toFactoryName, note: note?.trim() || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/production/trips');
  return { ok: true };
}

export async function updatePiggyback(id: string, status: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '请先登录' };
  const svc = createServiceRoleClient();
  const { error } = await (svc.from('trip_piggyback') as any).update({ status }).eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/production/trips');
  return { ok: true };
}
