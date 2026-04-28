-- ════════════════════════════════════════════════════════════════════════
-- P0 反向幽灵表修复 — Step 2：建立 procurement_line_items
-- 主题：补建采购对账明细表，恢复采购对账 / 成本控制 / leftover_collection 反哺
-- 日期：2026-04-28
-- 原则：
--   1. 仅建表 + RLS + 索引 + 触发器
--   2. 不改任何业务代码
--   3. 不批量回填历史数据
--   4. 不开新 UI 入口
--   5. 全部业务字段 nullable，不影响旧逻辑
--   6. 字段集 100% 来自 grep 现有 14 处代码引用反推
--   7. ordered_amount / difference_amount / difference_pct 三个统计字段用 GENERATED 列实现
--      （代码只读不写，由 PG 自动维护）
--
-- 目标修复点（28 处反向幽灵中的后 14 处）：
--   - app/actions/procurement.ts (×11)         — 采购对账"添加 / 删除 / 同步 / 录入"按钮全部恢复
--   - app/actions/cost-control.ts:153          — 成本控制 tab 显示真实采购数据
--   - app/actions/milestones.ts:696            — leftover_collection 节点反哺真实单耗到 quoter_fabric_records
--   - app/api/cron/cost-monitoring:58          — 6h cron 能扫描超预算面料采购
--
-- 关联但不重叠的现有表：
--   - procurement_tracking ：高层进度跟踪（"采了什么"），通过 syncFromProcurementTracking() 流入本表
--   - materials_bom        ：物料清单（订单层规划），与本表（执行层）互补
--   - order_cost_baseline  ：成本基线，提供 budget_fabric_kg 用于本表的预算告警
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.procurement_line_items (
  -- ─── 主键 + 关联 ───────────────────────────────────────────
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            uuid NOT NULL
                      REFERENCES public.orders(id) ON DELETE CASCADE,

  -- ─── 物料属性 ──────────────────────────────────────────────
  material_name       text NOT NULL,                     -- 物料名（addItem 唯一必填字段）
  material_code       text NULL,                          -- 物料编码
  specification       text NULL,                          -- 规格
  supplier_name       text NULL,                          -- 供应商名称
  category            text NULL DEFAULT 'fabric',         -- 'fabric' / 'trim' / 'packing' / 'other'

  -- ─── 订购维度 ──────────────────────────────────────────────
  ordered_qty         numeric NOT NULL DEFAULT 0,         -- 订购数量
  ordered_unit        text NULL DEFAULT 'KG',             -- 单位（KG / 个 / 米 / 件 等）
  unit_price          numeric NULL,                       -- 单价
  qty_per_piece       numeric NULL,                       -- 辅料：每件产品用量
  order_quantity      integer NULL,                       -- 订单数量缓存（用于辅料预算回算）
  budget_qty          numeric NULL,                       -- 预算量（来自 cost_baseline 或辅料用量×订单×1.03）

  -- ─── 实收维度 ──────────────────────────────────────────────
  received_qty        numeric NULL,                       -- 实收数量（NULL = 未收）
  received_unit       text NULL,                          -- 实收单位
  received_at         timestamptz NULL,                   -- 实收时间
  received_by         uuid NULL
                      REFERENCES auth.users(id) ON DELETE SET NULL,

  -- ─── 状态 / 备注 ───────────────────────────────────────────
  status              text NULL,                          -- 'complete' / 'partial' / 'over' / 'cancelled'
  notes               text NULL,                          -- 备注

  -- ─── 录入信息 ──────────────────────────────────────────────
  ordered_by          uuid NULL
                      REFERENCES auth.users(id) ON DELETE SET NULL,
  ordered_at          timestamptz NULL,

  -- ─── 标准时间戳 ────────────────────────────────────────────
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- ─── 派生统计字段（GENERATED，代码只读，PG 自动维护）─────
  -- ordered_amount = 订购金额 = ordered_qty × unit_price
  ordered_amount      numeric GENERATED ALWAYS AS (
    CASE
      WHEN unit_price IS NOT NULL
      THEN ordered_qty * unit_price
      ELSE NULL
    END
  ) STORED,

  -- difference_amount = 差异金额 = (received_qty - ordered_qty) × unit_price
  difference_amount   numeric GENERATED ALWAYS AS (
    CASE
      WHEN received_qty IS NOT NULL AND unit_price IS NOT NULL
      THEN (received_qty - ordered_qty) * unit_price
      ELSE NULL
    END
  ) STORED,

  -- difference_pct = 差异百分比 = (received_qty - ordered_qty) / ordered_qty × 100
  difference_pct      numeric GENERATED ALWAYS AS (
    CASE
      WHEN received_qty IS NOT NULL AND ordered_qty IS NOT NULL AND ordered_qty <> 0
      THEN ((received_qty - ordered_qty) / ordered_qty) * 100
      ELSE NULL
    END
  ) STORED
);

COMMENT ON TABLE public.procurement_line_items IS
  '采购对账明细（一对多）— 一行 = 一笔物料采购单。订购 vs 实收 vs 预算的精确数额，是 cost-monitoring cron 与 leftover_collection 反哺 RAG 的数据源';

-- ─── 索引 ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_procurement_line_items_order_id
  ON public.procurement_line_items (order_id);
CREATE INDEX IF NOT EXISTS idx_procurement_line_items_order_category
  ON public.procurement_line_items (order_id, category);
CREATE INDEX IF NOT EXISTS idx_procurement_line_items_order_status
  ON public.procurement_line_items (order_id, status)
  WHERE status IS NOT NULL;

-- ─── updated_at 自动维护触发器 ────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_procurement_line_items_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS procurement_line_items_set_updated_at ON public.procurement_line_items;
CREATE TRIGGER procurement_line_items_set_updated_at
  BEFORE UPDATE ON public.procurement_line_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_procurement_line_items_set_updated_at();

-- ════════════════════════════════════════════════════════════════════════
-- RLS — 严格按用户指令"统一走 user_can_access_order(order_id)"
-- 写权限叠加 procurement / merchandiser / admin 角色检查
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE public.procurement_line_items ENABLE ROW LEVEL SECURITY;

-- SELECT：能看订单 → 能看采购明细
DROP POLICY IF EXISTS "pli_select" ON public.procurement_line_items;
CREATE POLICY "pli_select" ON public.procurement_line_items FOR SELECT
USING (
  auth.uid() IS NOT NULL
  AND public.user_can_access_order(auth.uid(), order_id)
);

-- INSERT：admin / procurement / merchandiser / 订单创建者 / 订单负责人
DROP POLICY IF EXISTS "pli_insert" ON public.procurement_line_items;
CREATE POLICY "pli_insert" ON public.procurement_line_items FOR INSERT
WITH CHECK (
  auth.uid() IS NOT NULL
  AND public.user_can_access_order(auth.uid(), order_id)
  AND (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (
          p.role IN ('admin','procurement','merchandiser')
          OR (p.roles && ARRAY['admin','procurement','merchandiser']::text[])
        )
    )
    OR EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_id
        AND (o.created_by = auth.uid() OR o.owner_user_id = auth.uid())
    )
  )
);

-- UPDATE：同 INSERT
DROP POLICY IF EXISTS "pli_update" ON public.procurement_line_items;
CREATE POLICY "pli_update" ON public.procurement_line_items FOR UPDATE
USING (
  auth.uid() IS NOT NULL
  AND public.user_can_access_order(auth.uid(), order_id)
)
WITH CHECK (
  auth.uid() IS NOT NULL
  AND public.user_can_access_order(auth.uid(), order_id)
  AND (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (
          p.role IN ('admin','procurement','merchandiser')
          OR (p.roles && ARRAY['admin','procurement','merchandiser']::text[])
        )
    )
    OR EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_id
        AND (o.created_by = auth.uid() OR o.owner_user_id = auth.uid())
    )
  )
);

-- DELETE：admin / procurement / 订单创建者
DROP POLICY IF EXISTS "pli_delete" ON public.procurement_line_items;
CREATE POLICY "pli_delete" ON public.procurement_line_items FOR DELETE
USING (
  auth.uid() IS NOT NULL
  AND (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (
          p.role IN ('admin','procurement')
          OR (p.roles && ARRAY['admin','procurement']::text[])
        )
    )
    OR EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_id AND o.created_by = auth.uid()
    )
  )
);

-- ════════════════════════════════════════════════════════════════════════
-- 回滚 SQL（粘到 SQL Editor 一次性撤销）
-- ════════════════════════════════════════════════════════════════════════
--
-- DROP TRIGGER IF EXISTS procurement_line_items_set_updated_at ON public.procurement_line_items;
-- DROP FUNCTION IF EXISTS public.tg_procurement_line_items_set_updated_at();
-- DROP INDEX IF EXISTS public.idx_procurement_line_items_order_status;
-- DROP INDEX IF EXISTS public.idx_procurement_line_items_order_category;
-- DROP INDEX IF EXISTS public.idx_procurement_line_items_order_id;
-- ALTER TABLE public.procurement_line_items RENAME TO procurement_line_items_failed_20260428;
-- (如需彻底删除：再 DROP POLICY × 4 + DROP TABLE)

-- ════════════════════════════════════════════════════════════════════════
-- 冒烟测试（人工 SQL Editor 执行验证）
-- ════════════════════════════════════════════════════════════════════════
--
-- 1. 表存在性
--    SELECT EXISTS (
--      SELECT 1 FROM information_schema.tables
--      WHERE table_schema='public' AND table_name='procurement_line_items'
--    );  → true
--
-- 2. GENERATED 列正常工作（插一条临时行测试，事后删除）
--    -- 用 admin 账号在 SQL Editor 执行（service_role bypass RLS）：
--    INSERT INTO public.procurement_line_items
--      (order_id, material_name, ordered_qty, unit_price, received_qty)
--    SELECT id, 'TEST_MATERIAL', 100, 5, 95 FROM public.orders LIMIT 1
--    RETURNING id, ordered_amount, difference_amount, difference_pct;
--    -- 预期：ordered_amount=500, difference_amount=-25, difference_pct=-5
--    -- 验证完立即删：DELETE FROM public.procurement_line_items WHERE material_name='TEST_MATERIAL';
--
-- 3. RLS 启用 + Policy 数量
--    SELECT relrowsecurity FROM pg_class WHERE oid='public.procurement_line_items'::regclass;
--    → true
--    SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='procurement_line_items';
--    → 4
--
-- 4. 索引数量
--    SELECT indexname FROM pg_indexes
--    WHERE schemaname='public' AND tablename='procurement_line_items';
--    → 4 个：PK + idx_..._order_id + idx_..._order_category + idx_..._order_status
--
-- 5. 真实路径测试：
--    a) 打开订单详情 → 成本控制 tab
--       预期：getCostControlSummary 不再因为 procurement_line_items 不存在而 data=null
--    b) 采购员账号点"添加采购明细"按钮
--       预期：addProcurementItem 成功，不再报 relation does not exist
--    c) 跑 cost-monitoring cron（手动触发）
--       预期：能扫到 baseline 与采购数据，alerts 不再永远为 0（如有真实超预算）
