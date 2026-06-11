-- ===== 20260613_02 procurement_tracking → procurement_line_items 一次性迁移 =====
-- 决策1（双表合并）落地：tracking 冻结为历史只读，line_items 为唯一执行行表。
-- ⚠️ 已于 2026-06-13 在生产执行：迁移 149 行（37 个活跃订单，全部 → pending_order，
--    Step C 验证 pending_order=149 与 Step A 字段画像吻合）。本文件为 repo 存档，幂等可重跑（legacy_tracking_id 锚去重）。
-- 映射：actual_arrival 有值→arrived；order_date 有值→ordered；其余→pending_order。
--       quantity 为自由文本，不强转数字，并入 notes 防丢失。非活跃订单的 tracking 行不迁（随冻结留历史）。

ALTER TABLE public.procurement_line_items ADD COLUMN IF NOT EXISTS legacy_tracking_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pli_legacy_tracking
  ON public.procurement_line_items(legacy_tracking_id) WHERE legacy_tracking_id IS NOT NULL;

DO $$
DECLARE v_candidates int; v_inserted int;
BEGIN
  select count(*) into v_candidates
  from public.procurement_tracking t
  join public.orders o on o.id = t.order_id
  where o.lifecycle_status not in ('completed','已完成','cancelled','已取消')
    and not exists (select 1 from public.procurement_line_items l where l.legacy_tracking_id = t.id);

  if v_candidates = 0 then raise notice '无待迁移行（可能已迁移过）'; return; end if;

  insert into public.procurement_line_items
    (order_id, material_name, category, supplier_name, ordered_qty,
     line_status, ordered_at, expected_arrival, received_at, notes,
     is_supplement, supplement_reason, approved_by_name, approved_at,
     legacy_tracking_id, created_at)
  select
    t.order_id, t.item_name, coalesce(t.category,'other'), t.supplier, 0,
    case when t.actual_arrival is not null then 'arrived'
         when t.order_date     is not null then 'ordered'
         else 'pending_order' end,
    t.order_date::timestamptz, t.expected_arrival, t.actual_arrival::timestamptz,
    nullif(concat_ws(E'\n',
      case when nullif(t.quantity,'') is not null then '数量: '||t.quantity end,
      nullif(t.notes,''),
      '[migrated from procurement_tracking]'), ''),
    coalesce(t.is_supplement,false), t.supplement_reason, t.approved_by_name, t.approved_at,
    t.id, t.created_at
  from public.procurement_tracking t
  join public.orders o on o.id = t.order_id
  where o.lifecycle_status not in ('completed','已完成','cancelled','已取消')
    and not exists (select 1 from public.procurement_line_items l where l.legacy_tracking_id = t.id);

  get diagnostics v_inserted = ROW_COUNT;
  if v_inserted <> v_candidates then
    raise exception 'ABORT: 候选 % 行但插入 % 行，已整体回滚', v_candidates, v_inserted;
  end if;
  raise notice '✅ 迁移完成: % 行（候选=插入，校验通过）', v_inserted;
END $$;
