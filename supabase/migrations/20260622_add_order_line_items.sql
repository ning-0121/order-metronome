-- ===== 20260622 订单明细行 order_line_items(MVP:保存 PO 解析结果 + 支撑碎单预警)=====
-- 背景:建单时 AI 已解析出逐款逐色明细,但只填了 3 个汇总数、明细被丢弃 → 每次要明细就重复解析烧钱,
--   且碎单预警拿不到逐色真实量。此表把解析结果落库一次、永久复用。
-- 设计依据:docs/order-line-items-design.md(阶段0)。仅加表,不动现有订单/表。幂等。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行,Claude 不执行。

CREATE TABLE IF NOT EXISTS public.order_line_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- FK 必须显式声明,否则 PostgREST 嵌套 join 静默报 "Could not find a relationship"(CLAUDE.md 血泪教训)
  order_id      uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  line_no       int,                          -- 行序(对齐 PO 顺序)
  style_no      text,                         -- 款号
  product_name  text,                         -- 款名(可空)
  color_cn      text,                         -- 颜色中文
  color_en      text,                         -- 颜色英文
  sizes         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- 尺码配比 {"S":10,"M":30}
  unit          text NOT NULL DEFAULT 'pcs',  -- 行级单位 pcs/套/三件套
  set_multiplier int NOT NULL DEFAULT 1,      -- 折件倍率(与 orders.ts 件/套换算同口径)
  qty_pcs       int,                          -- 权威数量(件)= Σsizes × set_multiplier;碎单预警按此判每色量
  qty_raw       int,                          -- 客户原始数字(几套/几件),用于还原 PO
  source        text NOT NULL DEFAULT 'po_parse',  -- po_parse / manual / backfill
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_line_items_order_id ON public.order_line_items(order_id);

-- RLS:与订单子表一致(登录可读;写在建单链路里走 service-role/登录会话)
ALTER TABLE public.order_line_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "oli_select_auth" ON public.order_line_items;
CREATE POLICY "oli_select_auth" ON public.order_line_items FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS "oli_insert_auth" ON public.order_line_items;
CREATE POLICY "oli_insert_auth" ON public.order_line_items FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS "oli_update_auth" ON public.order_line_items;
CREATE POLICY "oli_update_auth" ON public.order_line_items FOR UPDATE USING (auth.uid() IS NOT NULL);

COMMENT ON TABLE public.order_line_items IS 'PO 解析出的订单明细行(逐款逐色)。建单时落库一次,供碎单预警/单据/分析复用,避免重复 AI 解析。';
