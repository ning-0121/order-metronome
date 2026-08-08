-- TS1 Founder Dogfood telemetry(2026-08-11)—— 极轻,只记验证指标,不存原始输入副本
-- (原始输入真相源已在 executive_captures)。一次 capture 一行,确认/放弃时回填。
create table if not exists public.exec_validation_events (
  id uuid primary key default gen_random_uuid(),
  capture_id uuid not null references public.executive_captures(id) on delete cascade,
  extraction_latency_ms integer,
  extracted_fields jsonb,             -- 抽到的字段结构(非原文;owner_hint/deadline_text/constraint 等)
  ceo_correction_count integer,        -- CEO 在确认卡上改了几个字段
  outcome text check (outcome in ('confirmed','abandoned')),
  retry_count integer default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_exec_valev_capture on public.exec_validation_events(capture_id);
alter table public.exec_validation_events enable row level security;
drop policy if exists exec_valev_sel on public.exec_validation_events;
create policy exec_valev_sel on public.exec_validation_events for select using (
  exists (select 1 from public.profiles p where p.user_id = auth.uid() and (p.role='admin' or 'admin'=any(p.roles)))
);
-- 仅 service-role 写
