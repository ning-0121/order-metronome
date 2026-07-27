-- 打样费(2026-07-27 CEO:打样费要能记账 + 谁承担)。
-- orders 加两列:sample_fee(金额,¥)+ sample_fee_bearer(承担方)。幂等。
-- 打样费属"谁承担 + 多少钱"的定性+定量,财务据此对客户收/免。full 应收收款联动为后续。

alter table public.orders add column if not exists sample_fee numeric;
alter table public.orders add column if not exists sample_fee_bearer text;   -- company / customer / fabric_customer / tbd

comment on column public.orders.sample_fee is '打样费金额(¥);仅打样单用';
comment on column public.orders.sample_fee_bearer is '打样费承担方:company(公司承担)/customer(客户承担)/fabric_customer(面料客户+加工公司)/tbd(待确认)';
