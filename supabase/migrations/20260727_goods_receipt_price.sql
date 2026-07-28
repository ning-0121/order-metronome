-- 收货记录补填价格(2026-07-27 CEO)
-- 前期有些辅料要单独开版费等,下单时无法给准价 → 收货后在「收货记录」补录真实单价/附加费,
-- 导出对账表时带上正确金额提交财务。字段落在 goods_receipts(收货流水),一行收货一价。
-- 幂等:重复执行安全。

alter table public.goods_receipts add column if not exists unit_price   numeric;  -- 补录单价(不含税)
alter table public.goods_receipts add column if not exists extra_fee    numeric;  -- 附加费(开版费等一次性)
alter table public.goods_receipts add column if not exists price_note    text;    -- 价格备注(税率/开版说明)
alter table public.goods_receipts add column if not exists price_filled_by uuid;  -- 谁补的价(审计)
alter table public.goods_receipts add column if not exists price_filled_at timestamptz;

comment on column public.goods_receipts.unit_price is '收货补录单价(不含税),元/收货单位';
comment on column public.goods_receipts.extra_fee is '附加费(开版费等一次性),元';
comment on column public.goods_receipts.price_note is '价格备注:税率/开版费说明等';
