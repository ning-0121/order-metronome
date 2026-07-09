-- ========================================================================
-- 订单 PI(形式发票 Proforma Invoice)· 可编辑内容(2026-07-09 用户)
-- ========================================================================
-- 业务上传客户 PO 后,系统从「生产单(逐款明细)」带出款/色/面料/数量,FOB 取客户 PO 成交价,
-- 交期取出厂日 → 生成 PI 草稿。业务可改价/折扣/交期/买方信息,存本表(jsonb),再预览/下载 Excel。
-- 卖方公司+银行信息是固定常量(在代码里),不入库。纯加法。⚠️ 由人手动在 Supabase 执行。

CREATE TABLE IF NOT EXISTS public.order_pi (
  order_id   uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { buyer_name, buyer_address, buyer_tel, contract_no, ready_to_ship, discount_pct, currency, lines:[{style_no,color,fabric,qty,fob}] }
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id)
);

ALTER TABLE public.order_pi ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "order_pi_rw_auth" ON public.order_pi;
CREATE POLICY "order_pi_rw_auth" ON public.order_pi
  FOR ALL USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);

-- 验证:SELECT to_regclass('public.order_pi');  -- 期望非 NULL
-- 回滚:DROP TABLE public.order_pi;
