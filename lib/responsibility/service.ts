import type { CanonicalResponsibility } from '@/lib/domain/responsibility-model';

export type ResponsibilitySource = 'explicit' | 'legacy_derived' | 'missing';
export type EffectiveResponsibility = {
  type: CanonicalResponsibility;
  userId: string | null;
  source: ResponsibilitySource;
  recordId?: string;
};

export type ResponsibilityActor = { userId: string; roles: string[] };
type Db = { from: (table: string) => any; rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: any; error: any }> };

const COMPATIBLE_ROLES: Record<CanonicalResponsibility, readonly string[]> = {
  development_owner: ['sales', 'sales_manager'],
  business_execution_owner: ['merchandiser', 'order_manager'],
  production_manager_owner: ['production_manager'],
  production_follow_up_owner: ['production', 'qc', 'quality'],
  procurement_owner: ['procurement', 'procurement_manager'],
  logistics_owner: ['logistics'],
  finance_owner: ['finance'],
};

const ASSIGNERS: Record<CanonicalResponsibility, readonly string[]> = {
  development_owner: ['sales_manager'],
  business_execution_owner: ['order_manager', 'sales_manager'],
  production_manager_owner: ['order_manager', 'production_manager'],
  production_follow_up_owner: ['production_manager'],
  procurement_owner: ['procurement_manager', 'order_manager'],
  logistics_owner: ['order_manager', 'logistics'],
  finance_owner: ['finance'],
};

function missingTable(error: any): boolean {
  return /order_responsibilities|schema cache|does not exist|PGRST205/i.test(String(error?.message || error?.code || ''));
}

export function assertAssignmentAuthority(actor: ResponsibilityActor, type: CanonicalResponsibility, reason: string): void {
  if (!reason.trim()) throw new Error('指派或改派必须填写原因');
  if (actor.roles.includes('admin')) return;
  if (!actor.roles.some((r) => ASSIGNERS[type].includes(r))) throw new Error('当前角色无权指派此责任');
}

export async function assertEligibleAssignee(db: Db, userId: string, type: CanonicalResponsibility): Promise<void> {
  const { data, error } = await db.from('profiles').select('user_id, role, roles, active').eq('user_id', userId).maybeSingle();
  if (error || !data) throw new Error('责任人不存在');
  if (data.active === false) throw new Error('离职或停用员工不能被指派');
  const roles: string[] = data.roles?.length ? data.roles : [data.role].filter(Boolean);
  if (!roles.some((r) => COMPATIBLE_ROLES[type].includes(r))) throw new Error('责任人的角色与责任类型不匹配');
}

export async function getActiveResponsibilities(db: Db, orderId: string): Promise<EffectiveResponsibility[]> {
  const { data, error } = await db.from('order_responsibilities').select('id,responsibility_type,user_id').eq('order_id', orderId).eq('status', 'active');
  if (error) { if (missingTable(error)) return []; throw error; }
  return (data || []).map((r: any) => ({ type: r.responsibility_type, userId: r.user_id, source: 'explicit', recordId: r.id }));
}

export async function getResponsibility(db: Db, orderId: string, type: CanonicalResponsibility): Promise<EffectiveResponsibility | null> {
  return (await getActiveResponsibilities(db, orderId)).find((r) => r.type === type) || null;
}

export async function replaceResponsibility(db: Db, actor: ResponsibilityActor, input: {
  orderId: string; type: CanonicalResponsibility; userId: string; reason: string; sourceType?: string; sourceId?: string;
}): Promise<any> {
  assertAssignmentAuthority(actor, input.type, input.reason);
  await assertEligibleAssignee(db, input.userId, input.type);
  const { data, error } = await db.rpc('replace_order_responsibility', {
    p_order_id: input.orderId, p_type: input.type, p_user_id: input.userId, p_actor_id: actor.userId,
    p_reason: input.reason.trim(), p_source_type: input.sourceType || 'manual', p_source_id: input.sourceId || null,
  });
  if (error) throw error;
  return data;
}

export const assignResponsibility = replaceResponsibility;
export const ensureResponsibility = replaceResponsibility;

export async function endResponsibility(db: Db, actor: ResponsibilityActor, input: { orderId: string; type: CanonicalResponsibility; reason: string }): Promise<void> {
  assertAssignmentAuthority(actor, input.type, input.reason);
  const current = await getResponsibility(db, input.orderId, input.type);
  if (!current?.recordId) return;
  const { error } = await db.from('order_responsibilities').update({ status: 'ended', ends_at: new Date().toISOString(), ended_by: actor.userId, end_reason: input.reason, updated_at: new Date().toISOString() }).eq('id', current.recordId).eq('status', 'active');
  if (error) throw error;
}

export function deriveLegacyResponsibilities(order: any, milestones: any[] = []): EffectiveResponsibility[] {
  const out: EffectiveResponsibility[] = [];
  const add = (type: CanonicalResponsibility, userId: string | null | undefined) => userId && out.push({ type, userId, source: 'legacy_derived' });
  add('business_execution_owner', order.owner_user_id || order.created_by);
  const explicitRules: Array<[CanonicalResponsibility, readonly string[]]> = [
    ['production_manager_owner', ['production_manager']], ['production_follow_up_owner', ['production', 'qc', 'quality']],
    ['procurement_owner', ['procurement', 'procurement_manager']], ['logistics_owner', ['logistics']], ['finance_owner', ['finance']],
  ];
  for (const [type, roles] of explicitRules) add(type, milestones.find((m) => roles.includes(m.owner_role) && m.owner_user_id)?.owner_user_id);
  return out;
}

export async function getEffectiveResponsibilities(db: Db, orderId: string): Promise<EffectiveResponsibility[]> {
  const explicit = await getActiveResponsibilities(db, orderId);
  const [{ data: order, error: oe }, { data: milestones, error: me }] = await Promise.all([
    db.from('orders').select('id,owner_user_id,created_by').eq('id', orderId).maybeSingle(),
    db.from('milestones').select('owner_role,owner_user_id').eq('order_id', orderId),
  ]);
  if (oe) throw oe; if (me) throw me;
  const derived = deriveLegacyResponsibilities(order || {}, milestones || []);
  const map = new Map<CanonicalResponsibility, EffectiveResponsibility>();
  for (const row of derived) map.set(row.type, row);
  for (const row of explicit) map.set(row.type, row);
  return [...map.values()];
}
