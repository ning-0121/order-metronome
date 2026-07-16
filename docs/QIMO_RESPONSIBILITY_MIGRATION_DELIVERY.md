# QIMO Responsibility Migration Delivery

Target: Supabase `scrtebexbxablybqpdla`. Status: prepared, reviewed, **not executed**.

## Objects

- `public.order_responsibilities`
- `public.order_operational_decisions`
- three responsibility indexes and one decision index
- SELECT-only authenticated RLS policies using `user_can_access_order`
- service-role-only atomic RPC `replace_order_responsibility`

No historical `UPDATE`, backfill, `DROP`, `DELETE` or `TRUNCATE`. No client write policy. Active uniqueness is scoped to `(order_id, responsibility_type) WHERE status='active'`.

## Read-only verification SQL

```sql
select table_name from information_schema.tables
 where table_schema='public' and table_name in ('order_responsibilities','order_operational_decisions') order by 1;

select table_name,column_name,data_type,is_nullable,column_default
  from information_schema.columns
 where table_schema='public' and table_name in ('order_responsibilities','order_operational_decisions')
 order by table_name,ordinal_position;

select schemaname,tablename,indexname,indexdef from pg_indexes
 where schemaname='public' and tablename in ('order_responsibilities','order_operational_decisions') order by tablename,indexname;

select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_policies
 where schemaname='public' and tablename in ('order_responsibilities','order_operational_decisions') order by tablename,policyname;

select n.nspname as schema_name,p.proname,pg_get_function_identity_arguments(p.oid) as arguments,
       p.prosecdef as security_definer
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname='replace_order_responsibility';

select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname in ('order_responsibilities','order_operational_decisions');
```

## Lock and rollback

Creating two empty tables and indexes takes short catalog locks; no existing business table rewrite occurs. Foreign keys read existing catalogs only. Execute during a quiet window. Rollback, only if no explicit responsibility writes exist, is a separately approved destructive action: revoke/drop the RPC, then drop the two new tables. Once rows exist, prefer disabling new writes and retaining history rather than dropping.

## Deployment order

1. CEO executes migration in SQL Editor.
2. Run the read-only verification SQL.
3. Deploy compatibility-capable code.
4. New handoffs/assignments write explicit responsibility; historical orders remain legacy-derived.
5. Do not mass backfill.
