-- ===== 2026-07-26 邮件附件捕获 mail_attachments(Phase 3 附件→PO OCR,CEO 批)=====
-- 客户 PO 常以 PDF 附件发来,原邮件管道只解析正文文本、不抓附件 → PO 要点断链。
-- T2a 捕获层:email-scan 从 MIME 抓 PDF/图片附件 → 存 order-docs 桶 → 落本表(一附件一行,关联 mail_inbox/订单)。
-- T2b OCR 层:对 PO 类附件跑 Claude Vision(po-extract)→ 回填 extracted_json/summary。省 token:仅对相关附件跑 Vision。
-- 全部幂等。

create table if not exists public.mail_attachments (
  id uuid primary key default gen_random_uuid(),
  mail_id uuid not null references public.mail_inbox(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  file_name text,
  mime_type text,
  storage_path text,               -- order-docs 桶内路径(mail/<mail_id>/<file>)
  size_bytes integer,
  is_po boolean default false,     -- 疑似 PO 附件(PDF/图片 + 类别PO/主题命中)→ 值得跑 OCR
  ocr_status text default 'pending', -- pending / done / skipped / failed
  extracted_json jsonb,            -- Vision 提取的 PO 要点(款/色/码/数量/单价/交期等)
  extract_summary text,            -- 一句话摘要
  ocr_at timestamptz,
  created_at timestamptz not null default now(),
  unique (mail_id, file_name)      -- 同一封同名附件只存一次(幂等)
);

create index if not exists idx_mail_att_mail on public.mail_attachments(mail_id);
create index if not exists idx_mail_att_order on public.mail_attachments(order_id);
-- 待 OCR 队列:疑似 PO 且未处理
create index if not exists idx_mail_att_pending_ocr on public.mail_attachments(created_at)
  where is_po = true and ocr_status = 'pending';

comment on table public.mail_attachments is
  '邮件附件(CEO 2026-07-26):从 MIME 抓的 PDF/图片,存 order-docs 桶;PO 类跑 Vision 回填要点。一附件一行。';

alter table public.mail_attachments enable row level security;
drop policy if exists mail_att_read on public.mail_attachments;
create policy mail_att_read on public.mail_attachments for select to authenticated using (true);
grant select on public.mail_attachments to authenticated;
