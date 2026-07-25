-- ===== 2026-07-25 邮件归纳层:给 mail_inbox 补"归纳"列(CEO 批 Phase 0-2)=====
-- 现有 mail_inbox 是 2024 原始收信表,只有 from/subject/body/extracted_po,没有归纳结果。
-- Phase 1 归纳引擎(规则分类 + Haiku 批量摘要)把结果物化到下列;Phase 2 看板/每日汇总只读这些列(读时零 AI)。
-- 全部幂等(add column if not exists);不动主链路既有列。

alter table public.mail_inbox
  add column if not exists category         text,            -- 交期/样品/投诉/PO/报价/物流/其他/噪音
  add column if not exists summary          text,            -- 一句话摘要(Tier 1 产出)
  add column if not exists importance        smallint,        -- 重点度 1-3(=3 进重点监控)
  add column if not exists needs_action      boolean,         -- 是否要人处理
  add column if not exists action_type       text,            -- 回复/改单/催确认/升级/无
  add column if not exists assigned_exec_id  uuid,            -- 归属业务执行(按订单负责人/客户带出)
  add column if not exists handled_status    text default 'unread',  -- unread/seen/handled/ignored
  add column if not exists ai_tier           text,            -- rule/haiku/sonnet:走到哪层(省 token 审计)
  add column if not exists digested_at       timestamptz;     -- 何时归纳完(NULL=未归纳;增量只处理 NULL)

-- 增量拉取:未归纳的邮件(digested_at IS NULL),按收信时间
create index if not exists idx_mail_inbox_undigested
  on public.mail_inbox(received_at) where digested_at is null;

-- 看板:按归属业务执行 + 处理状态 + 重点度 查当日邮件
create index if not exists idx_mail_inbox_exec_handled
  on public.mail_inbox(assigned_exec_id, handled_status, received_at desc);

-- 重点监控:高重点 / 投诉·交期 且未处理
create index if not exists idx_mail_inbox_importance
  on public.mail_inbox(importance, received_at desc) where importance is not null;

comment on column public.mail_inbox.category is '邮件归纳类别(规则先给,AI 校正):交期/样品/投诉/PO/报价/物流/其他/噪音';
comment on column public.mail_inbox.digested_at is 'Phase1 归纳完成时间;NULL=未归纳(增量处理游标)';
