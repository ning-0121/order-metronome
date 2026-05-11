-- ===== 2026-05-09 customer_rhythm P&L 字段扩展 =====
-- 目的：让 customer_rhythm 成为客户画像的唯一 SoT
-- 这 8 个字段由 customer-pnl.service.ts materializer 写入，页面只读
-- materializer 通过 /api/cron/daily 触发，不允许页面临时计算

ALTER TABLE public.customer_rhythm
  ADD COLUMN IF NOT EXISTS avg_margin_pct         numeric,
  ADD COLUMN IF NOT EXISTS total_revenue_cny       numeric,
  ADD COLUMN IF NOT EXISTS margin_trend            text CHECK (margin_trend IN ('up','down','flat','unknown')),
  ADD COLUMN IF NOT EXISTS on_time_delivery_rate   integer CHECK (on_time_delivery_rate IS NULL OR (on_time_delivery_rate >= 0 AND on_time_delivery_rate <= 100)),
  ADD COLUMN IF NOT EXISTS avg_deposit_delay_days  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS overdue_payments        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS behavior_tags           text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS profile_updated_at      timestamptz;

COMMENT ON COLUMN public.customer_rhythm.avg_margin_pct        IS 'materializer 写：平均毛利率 %，来自 profit_snapshots';
COMMENT ON COLUMN public.customer_rhythm.total_revenue_cny     IS 'materializer 写：累计销售额（人民币）';
COMMENT ON COLUMN public.customer_rhythm.margin_trend          IS 'materializer 写：近三单利润率趋势';
COMMENT ON COLUMN public.customer_rhythm.on_time_delivery_rate IS 'materializer 写：准时交付率 %，NULL 表示复盘数据不足';
COMMENT ON COLUMN public.customer_rhythm.avg_deposit_delay_days IS 'materializer 写：定金平均延迟天数';
COMMENT ON COLUMN public.customer_rhythm.overdue_payments      IS 'materializer 写：历史逾期付款次数';
COMMENT ON COLUMN public.customer_rhythm.behavior_tags         IS 'materializer 写：客户行为标签数组';
COMMENT ON COLUMN public.customer_rhythm.profile_updated_at    IS 'materializer 写：最后一次 P&L 物化时间，NULL 表示尚未物化';
