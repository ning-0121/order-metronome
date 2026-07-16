import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { assertAssignmentAuthority, assertEligibleAssignee, deriveLegacyResponsibilities, getActiveResponsibilities, replaceResponsibility } from '../service';
import { recipientsForResponsibilityEvent } from '../notifications';
import { evaluateOrderClosure } from '../closure';

const profileDb = (profile: any, rpc?: (name: string, args: any) => any) => ({
  from(table: string) {
    if (table !== 'profiles') throw new Error(`unexpected ${table}`);
    return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile, error: null }) }) }) };
  },
  rpc: rpc || (async () => ({ data: { id: 'r1' }, error: null })),
});

describe('responsibility service contracts', () => {
  it('denies inactive and role-mismatched assignees', async () => {
    await assert.rejects(() => assertEligibleAssignee(profileDb({ user_id:'u', roles:['production'], active:false }) as any, 'u', 'production_follow_up_owner'), /停用/);
    await assert.rejects(() => assertEligibleAssignee(profileDb({ user_id:'u', roles:['sales'], active:true }) as any, 'u', 'production_follow_up_owner'), /不匹配/);
  });
  it('requires compatible assigner and reason', () => {
    assert.throws(() => assertAssignmentAuthority({ userId:'u', roles:['production'] }, 'production_follow_up_owner', '指派'), /无权/);
    assert.throws(() => assertAssignmentAuthority({ userId:'u', roles:['production_manager'] }, 'production_follow_up_owner', ''), /原因/);
  });
  it('passes authenticated actor into atomic replacement RPC', async () => {
    let args: any;
    const db = profileDb({ user_id:'follow', roles:['production'], active:true }, async (_n, a) => { args = a; return { data:{id:'r'}, error:null }; });
    await replaceResponsibility(db as any, { userId:'pm', roles:['production_manager'] }, { orderId:'o', type:'production_follow_up_owner', userId:'follow', reason:'排产确认后指派' });
    assert.equal(args.p_actor_id, 'pm'); assert.equal(args.p_user_id, 'follow');
  });
  it('treats an absent migration as no explicit rows, not a write/backfill', async () => {
    let writes = 0;
    const db = { from: () => ({ select: () => ({ eq: () => ({ eq: async () => ({ data:null, error:{ code:'PGRST205', message:'order_responsibilities missing' } }) }) }) }), rpc: async () => { writes++; return {data:null,error:null}; } };
    assert.deepEqual(await getActiveResponsibilities(db as any, 'o'), []); assert.equal(writes, 0);
  });
  it('keeps an empty migrated table compatible with legacy-derived reads', async () => {
    let writes = 0;
    const db = {
      from(table: string) {
        if (table === 'order_responsibilities') return { select: () => ({ eq: () => ({ eq: async () => ({ data:[],error:null }) }) }) };
        if (table === 'orders') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data:{id:'o',owner_user_id:'exec',created_by:'creator'},error:null }) }) }) };
        if (table === 'milestones') return { select: () => ({ eq: async () => ({ data:[{owner_role:'production',owner_user_id:'follow'}],error:null }) }) };
        throw new Error(`unexpected ${table}`);
      }, rpc: async () => { writes++; return {data:null,error:null}; },
    };
    const { getEffectiveResponsibilities } = await import('../service');
    const rows = await getEffectiveResponsibilities(db as any, 'o');
    assert.equal(rows.find((r) => r.type === 'business_execution_owner')?.userId, 'exec');
    assert.equal(rows.find((r) => r.type === 'production_follow_up_owner')?.source, 'legacy_derived');
    assert.equal(writes, 0);
  });
  it('serializes first assignment and centralizes responsibility ending in SQL', () => {
    const sql = readFileSync('supabase/migrations/20260716_order_responsibilities.sql', 'utf8');
    assert.match(sql, /FROM public\.orders WHERE id=p_order_id FOR UPDATE/);
    assert.match(sql, /FUNCTION public\.end_order_responsibility/);
    assert.match(sql, /trg_order_responsibilities_updated_at/);
  });
  it('derives legacy owners only from explicit role rules without persistence', () => {
    const rows = deriveLegacyResponsibilities({ owner_user_id:'exec' }, [
      { owner_role:'production', owner_user_id:'follow' }, { owner_role:'logistics', owner_user_id:'log' },
    ]);
    assert.equal(rows.find((r) => r.type === 'business_execution_owner')?.userId, 'exec');
    assert.ok(rows.every((r) => r.source === 'legacy_derived'));
  });
  it('routes cross-domain notifications to concurrent owners without duplicates', () => {
    const rows: any[] = [
      {type:'business_execution_owner',userId:'exec'}, {type:'production_manager_owner',userId:'pm'},
      {type:'production_follow_up_owner',userId:'follow'}, {type:'logistics_owner',userId:'log'}, {type:'finance_owner',userId:'fin'},
    ];
    assert.deepEqual(recipientsForResponsibilityEvent('qc_failure', rows), ['exec','pm','follow'].sort((a,b) => ['exec','pm','follow'].indexOf(a)-['exec','pm','follow'].indexOf(b)));
    assert.ok(recipientsForResponsibilityEvent('shipment_blocker', rows).includes('fin'));
  });
  it('blocks closure until shipment, execution, exception, finance and evidence conditions pass', () => {
    const base = { shipmentCompleted:true,businessExecutionConfirmed:true,exceptionsResolvedOrAccepted:true,financeSatisfied:true,evidenceComplete:true };
    assert.equal(evaluateOrderClosure(base).allowed, true);
    assert.deepEqual(evaluateOrderClosure({...base, financeSatisfied:false}).blockers, ['finance']);
  });
});
