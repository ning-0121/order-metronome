# Responsibility migration post-execution record

- Supabase project: `scrtebexbxablybqpdla`
- Manual execution date: 2026-07-16
- Confirmed live: `order_responsibilities`, `order_operational_decisions`, RLS enabled
- Read-only OpenAPI verification: all committed columns present; both tables contain 0 rows
- Historical backfill: none
- Production application status: responsibility implementation PR #24 is not deployed
- Compatibility: existing Production continues legacy ownership; new code reads explicit rows first and derives legacy owners without persisting them
- Remaining deployment dependency: apply the small RPC concurrency repair below, verify ACL/policies, then complete employee Preview acceptance before merge

Do not re-run the complete migration as a routine step. The repair is limited to replacing the two service-role RPCs and installing the `updated_at` trigger.

## Additive concurrency repair SQL — CEO manual execution required

This does not touch responsibility rows. It serializes first assignment by locking the parent order, adds an atomic end operation, and maintains `updated_at`.

```sql
CREATE OR REPLACE FUNCTION public.replace_order_responsibility(
  p_order_id uuid, p_type text, p_user_id uuid, p_actor_id uuid,
  p_reason text, p_source_type text DEFAULT 'manual', p_source_id text DEFAULT NULL
) RETURNS public.order_responsibilities
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE current_row public.order_responsibilities; result_row public.order_responsibilities;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'assignment_reason_required'; END IF;
  PERFORM 1 FROM public.orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  SELECT * INTO current_row FROM public.order_responsibilities
    WHERE order_id=p_order_id AND responsibility_type=p_type AND status='active' FOR UPDATE;
  IF current_row.user_id = p_user_id THEN RETURN current_row; END IF;
  IF current_row.id IS NOT NULL THEN
    UPDATE public.order_responsibilities SET status='superseded', ends_at=now(), ended_by=p_actor_id,
      end_reason=btrim(p_reason), updated_at=now() WHERE id=current_row.id;
  END IF;
  INSERT INTO public.order_responsibilities(order_id,responsibility_type,user_id,assigned_by,assignment_reason,source_type,source_id)
    VALUES(p_order_id,p_type,p_user_id,p_actor_id,btrim(p_reason),p_source_type,p_source_id)
    RETURNING * INTO result_row;
  RETURN result_row;
END $$;
REVOKE ALL ON FUNCTION public.replace_order_responsibility(uuid,text,uuid,uuid,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_order_responsibility(uuid,text,uuid,uuid,text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.end_order_responsibility(
  p_order_id uuid, p_type text, p_actor_id uuid, p_reason text
) RETURNS public.order_responsibilities
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE current_row public.order_responsibilities;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'end_reason_required'; END IF;
  PERFORM 1 FROM public.orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  SELECT * INTO current_row FROM public.order_responsibilities
    WHERE order_id=p_order_id AND responsibility_type=p_type AND status='active' FOR UPDATE;
  IF current_row.id IS NULL THEN RETURN NULL; END IF;
  UPDATE public.order_responsibilities SET status='ended', ends_at=now(), ended_by=p_actor_id,
    end_reason=btrim(p_reason), updated_at=now() WHERE id=current_row.id RETURNING * INTO current_row;
  RETURN current_row;
END $$;
REVOKE ALL ON FUNCTION public.end_order_responsibility(uuid,text,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.end_order_responsibility(uuid,text,uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.set_order_responsibility_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_order_responsibilities_updated_at'
    AND tgrelid='public.order_responsibilities'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER trg_order_responsibilities_updated_at BEFORE UPDATE ON public.order_responsibilities
      FOR EACH ROW EXECUTE FUNCTION public.set_order_responsibility_updated_at();
  END IF;
END $$;
```
