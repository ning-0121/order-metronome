-- ===== 2026-07-24 生产事故追责:production_issues 加责任认定字段 =====
-- 事故 = 生产问题里需要追责的那类。不另建对象(守单一真相源),在 production_issues 上补:
--   责任方 / 处理方式 / 赔偿金额 / 追责说明。纯加法,可回滚。
-- 回滚:alter table public.production_issues
--         drop column if exists responsible_party, drop column if exists disposition,
--         drop column if exists loss_amount, drop column if exists accountability_note;

alter table public.production_issues
  add column if not exists responsible_party text,      -- 责任方(哪个厂 / 工序 / 人)
  add column if not exists disposition text,            -- 处理/追责方式:rework返工 / scrap报废 / deduct扣款 / claim向厂索赔 / absorb自担 / other
  add column if not exists loss_amount numeric(12,2),   -- 损失 / 赔偿金额(¥)
  add column if not exists accountability_note text;     -- 追责说明(经过、认定依据、后续跟进)

comment on column public.production_issues.responsible_party is '生产事故责任方(哪个厂/工序/人)';
comment on column public.production_issues.disposition is '处理/追责方式:rework/scrap/deduct/claim/absorb/other';
comment on column public.production_issues.loss_amount is '损失/赔偿金额(¥)';
comment on column public.production_issues.accountability_note is '追责说明';
