-- ════════════════════════════════════════════════════════════════════════
-- 2026-05-15 — 分批出货节点感知（Option B 完整方案）
--
-- 背景：is_split_shipment=true 的订单，出货阶段的 5 个节点（验货放行 / 订舱 /
--      报关 / 核准出运 / 出运）逻辑上每批都要走一遍。原本 milestones 表
--      只有单实例，无法表达"3 批中 2 批已出"，造成业务无法完成。
--
-- 设计：在 shipment_batches 上加 jsonb 字段记录每批在各节点的完成时间。
--      主 milestone 状态从批次进度自动推导：所有批次都完成此节点 → 主节点 done。
--
-- 不影响：非分批订单（is_split_shipment=false）的逻辑完全不变。
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. 加 milestone_progress 字段 ──────────────────────────────────────
ALTER TABLE public.shipment_batches
  ADD COLUMN IF NOT EXISTS milestone_progress jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Schema 示例：
-- {
--   "inspection_release": "2026-05-10T08:30:00Z",
--   "booking_done": "2026-05-08T14:00:00Z",
--   "customs_export": null,
--   "finance_shipment_approval": null
-- }
--
-- shipment_execute 不放在这里 — 它仍用 shipment_batches.status='shipped'
--   + actual_ship_date 字段（前者枚举语义明确，后者已是核心数据）。

COMMENT ON COLUMN public.shipment_batches.milestone_progress IS
  '每批在出货阶段节点的完成时间戳。key=step_key, value=ISO 时间。
   仅记录 inspection_release/booking_done/customs_export/finance_shipment_approval。
   shipment_execute 用 status=shipped + actual_ship_date 表达。';

-- ─── 2. 索引（可选，便于"查所有未完成验货放行的批次"等场景） ──────────
CREATE INDEX IF NOT EXISTS idx_shipment_batches_progress
  ON public.shipment_batches USING gin (milestone_progress);

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- 验证 SQL（迁移后手动跑）
-- ════════════════════════════════════════════════════════════════════════
--
-- 1. 确认字段已加且默认 {}:
--    SELECT id, batch_no, milestone_progress FROM shipment_batches LIMIT 5;
--
-- 2. 测试写入：
--    UPDATE shipment_batches
--    SET milestone_progress = jsonb_set(milestone_progress, '{booking_done}', to_jsonb(now()::text))
--    WHERE id = '<batch-id>';
