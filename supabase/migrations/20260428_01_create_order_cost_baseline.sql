-- ════════════════════════════════════════════════════════════════════════
-- P0 反向幽灵表修复 — Step 1：建立 order_cost_baseline
-- 主题：补建生产路径正在调用的成本基线表，恢复 rootCauseEngine / profit.service / order-financials
-- 日期：2026-04-28
-- 原则：
--   1. 仅建表 + RLS + 索引 + 触发器
--   2. 不改任何业务代码
--   3. 不批量回填历史数据
--   4. 不连入 quoter_quotes / quote-bridge（留 Phase 2）
--   5. 全部字段 nullable（除主键和 order_id），不影响旧逻辑
--   6. 字段集 100% 来自 grep 现有 14 处代码引用反推（见文档 docs/db-table-usage-audit.md v3.1）
--
-- 目标修复点（28 处反向幽灵中的前 14 处）：
--   - lib/engine/rootCauseEngine.ts:52   — 不再因 Promise.all 崩溃返回 null
--   - lib/services/profit.service.ts:152  — Promise.allSettled 拿到正常 null
--   - app/actions/order-financials.ts:86  — recomputeOrderFinancials 利润不再永远 0
--   - app/actions/cost-control.ts (×6)    — CostControlSummary / uploadCostSheet / autoParse 不再静默吞错
--   - app/actions/milestones.ts:713       — leftover_collection 反哺单耗成功
--   - app/actions/quoter-training.ts:498  — CMT 训练样本导入有数据可读
--   - app/actions/procurement.ts:148      — 面料预算告警逻辑生效
--   - app/api/cron/cost-monitoring:33     — 6h cron 不再永远空跑
--   - lib/agent/skills/quoteReview.ts:174 — skill 已下线，不影响
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.order_cost_baseline (
  -- ─── 主键 + 关联 ───────────────────────────────────────────
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                 uuid NOT NULL UNIQUE
                           REFERENCES public.orders(id) ON DELETE CASCADE,

  -- ─── 面料维度（来自上传的"内部成本核算单" Excel）─────────
  fabric_area_m2           numeric NULL,            -- 纸样面积
  fabric_weight_kg_m2      numeric NULL,            -- 面料克重 KG/㎡
  fabric_consumption_kg    numeric NULL,            -- 单件面料用量 KG
  fabric_price_per_kg      numeric NULL,            -- 面料单价
  waste_pct                numeric NULL DEFAULT 3,  -- 损耗率 %
  budget_fabric_kg         numeric NULL,            -- 预算面料总量 KG
  budget_fabric_amount     numeric NULL,            -- 预算面料总额

  -- ─── 加工费维度 ────────────────────────────────────────────
  cmt_internal_estimate    numeric NULL,            -- 内部估算加工费
  cmt_factory_quote        numeric NULL,            -- 工厂报价加工费
  cmt_labor_rate           numeric NULL,            -- 人工率

  -- ─── 总价 / 售价 ───────────────────────────────────────────
  total_cost_per_piece     numeric NULL,            -- 总单件成本
  fob_price                numeric NULL,            -- FOB 单价
  ddp_price                numeric NULL,            -- DDP 单价
  exchange_rate            numeric NULL DEFAULT 7.2,-- 汇率（CNY → USD 默认 7.2）

  -- ─── 实际数据（leftover_collection 节点回填）───────────────
  actual_fabric_used_kg    numeric NULL,            -- 实际面料用量 KG
  actual_consumption_kg    numeric NULL,            -- 实际单耗 KG/件

  -- ─── 来源追溯 ──────────────────────────────────────────────
  source_file_name         text NULL,               -- 解析的 Excel 文件名
  parsed_at                timestamptz NULL,        -- 解析时间
  parsed_by                uuid NULL
                           REFERENCES auth.users(id) ON DELETE SET NULL,

  -- ─── 标准时间戳 ────────────────────────────────────────────
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.order_cost_baseline IS
  '订单成本基线（一对一）— 上传内部成本核算单 Excel 后写入，是利润计算/Root Cause/Quoter 训练的共同数据源';

-- ─── 索引（order_id 已通过 UNIQUE 自动建索引）─────────────
-- 不额外加索引：表是 1:1 with orders，最大行数 = 订单数（小表）

-- ─── updated_at 自动维护触发器 ────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_order_cost_baseline_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_cost_baseline_set_updated_at ON public.order_cost_baseline;
CREATE TRIGGER order_cost_baseline_set_updated_at
  BEFORE UPDATE ON public.order_cost_baseline
  FOR EACH ROW EXECUTE FUNCTION public.tg_order_cost_baseline_set_updated_at();

-- ════════════════════════════════════════════════════════════════════════
-- RLS — 严格按用户指令"统一走 user_can_access_order(order_id)"
-- 写权限再叠加 finance / merchandiser / admin 角色检查（成本数据敏感）
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE public.order_cost_baseline ENABLE ROW LEVEL SECURITY;

-- SELECT：能看订单 → 能看基线
DROP POLICY IF EXISTS "ocb_select" ON public.order_cost_baseline;
CREATE POLICY "ocb_select" ON public.order_cost_baseline FOR SELECT
USING (
  auth.uid() IS NOT NULL
  AND public.user_can_access_order(auth.uid(), order_id)
);

-- INSERT：admin / finance / merchandiser / 订单创建者 / 订单负责人
DROP POLICY IF EXISTS "ocb_insert" ON public.order_cost_baseline;
CREATE POLICY "ocb_insert" ON public.order_cost_baseline FOR INSERT
WITH CHECK (
  auth.uid() IS NOT NULL
  AND public.user_can_access_order(auth.uid(), order_id)
  AND (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (
          p.role IN ('admin','finance','merchandiser')
          OR (p.roles && ARRAY['admin','finance','merchandiser']::text[])
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
DROP POLICY IF EXISTS "ocb_update" ON public.order_cost_baseline;
CREATE POLICY "ocb_update" ON public.order_cost_baseline FOR UPDATE
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
          p.role IN ('admin','finance','merchandiser')
          OR (p.roles && ARRAY['admin','finance','merchandiser']::text[])
        )
    )
    OR EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_id
        AND (o.created_by = auth.uid() OR o.owner_user_id = auth.uid())
    )
  )
);

-- DELETE：仅 admin（成本基线一旦写入应保留作为审计依据）
DROP POLICY IF EXISTS "ocb_delete" ON public.order_cost_baseline;
CREATE POLICY "ocb_delete" ON public.order_cost_baseline FOR DELETE
USING (
  auth.uid() IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (p.role = 'admin' OR (p.roles && ARRAY['admin']::text[]))
  )
);

-- ════════════════════════════════════════════════════════════════════════
-- 回滚 SQL（粘到 SQL Editor 一次性撤销）
-- ════════════════════════════════════════════════════════════════════════
--
-- DROP TRIGGER IF EXISTS order_cost_baseline_set_updated_at ON public.order_cost_baseline;
-- DROP FUNCTION IF EXISTS public.tg_order_cost_baseline_set_updated_at();
-- ALTER TABLE public.order_cost_baseline RENAME TO order_cost_baseline_failed_20260428;
-- (RLS policies 会跟随表重命名继续存在；如需彻底删除：
--    DROP POLICY ocb_select   ON public.order_cost_baseline_failed_20260428;
--    DROP POLICY ocb_insert   ON public.order_cost_baseline_failed_20260428;
--    DROP POLICY ocb_update   ON public.order_cost_baseline_failed_20260428;
--    DROP POLICY ocb_delete   ON public.order_cost_baseline_failed_20260428;
--    DROP TABLE  public.order_cost_baseline_failed_20260428;)

-- ════════════════════════════════════════════════════════════════════════
-- 冒烟测试（人工 SQL Editor 执行验证）
-- ════════════════════════════════════════════════════════════════════════
--
-- 1. 表存在性
--    SELECT EXISTS (
--      SELECT 1 FROM information_schema.tables
--      WHERE table_schema='public' AND table_name='order_cost_baseline'
--    );  → true
--
-- 2. 唯一约束
--    SELECT conname FROM pg_constraint
--    WHERE conrelid = 'public.order_cost_baseline'::regclass AND contype='u';
--    → 应包含 (order_id) 上的唯一约束
--
-- 3. RLS 启用
--    SELECT relrowsecurity FROM pg_class WHERE oid='public.order_cost_baseline'::regclass;
--    → true
--
-- 4. Policy 数量
--    SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='order_cost_baseline';
--    → 4
--
-- 5. 真实路径测试（用任一登录用户）：
--    打开订单详情 → 成本控制 tab
--    预期：不再报 "relation order_cost_baseline does not exist"
--    预期：CostControlSummary 返回 baseline=null（因为还没数据）
--
-- 6. rootCauseEngine 修复验证：
--    在 admin 工具或 server action 调用 buildOrderContext(supabase, anyOrderId)
--    预期：不再返回 null（之前因 Promise.all 中 baseline 缺失而崩）
