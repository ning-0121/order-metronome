-- ===== 2026-07-26 企业微信会话存档消息 wecom_messages(CEO:客户群沟通归档 → 归纳 → 绑 PO 防漏)=====
-- 会话内容存档拉取器(自建服务器跑 SDK,方案 A)把解密后的客户群/单聊消息写进本表;
-- 节拍器复用邮件归纳引擎(规则分类 + Haiku 摘要 + 绑 PO + 重点监控),与 mail_inbox 同结构好共用。
-- 前提:企业微信侧开通「会话内容存档」+ 拉取器落数据(见接入操作指导)。本迁移只建表,空表无害。
-- 归纳列口径与 mail_inbox 一致(category/summary/importance/needs_action/action_type/assigned_exec_id/handled_status/ai_tier/digested_at)。

create table if not exists public.wecom_messages (
  id uuid primary key default gen_random_uuid(),
  msgid text unique,                 -- 企业微信消息唯一 id(去重)
  seq bigint,                        -- 会话存档拉取游标(单调递增)
  chat_type text,                    -- 'group'(客户群)| 'single'(单聊)
  roomid text,                       -- 群 id(群聊)
  room_name text,                    -- 群名
  from_userid text,                  -- 发送人(内部成员 userid 或外部客户 external_userid)
  from_name text,                    -- 发送人展示名
  is_external boolean default false, -- 发送人是否外部客户
  msgtype text,                      -- text/image/file/link/voice/...
  content text,                      -- 文本内容 / 富消息摘要文本
  media_path text,                   -- 图片/文件存 order-docs 桶的路径(非文本消息)
  msgtime timestamptz,               -- 消息时间

  -- 归纳 + 绑 PO(与 mail_inbox 同口径,复用归纳引擎)
  customer_name text,
  order_id uuid references public.orders(id) on delete set null,
  assigned_exec_id uuid,
  category text,                     -- 交期/样品/投诉/PO/报价/物流/其他/噪音
  summary text,
  importance smallint,
  needs_action boolean,
  action_type text,
  handled_status text default 'unread',
  ai_tier text,
  digested_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_wecom_msg_room on public.wecom_messages(roomid, msgtime desc);
create index if not exists idx_wecom_msg_order on public.wecom_messages(order_id);
create index if not exists idx_wecom_msg_undigested on public.wecom_messages(msgtime) where digested_at is null;
create index if not exists idx_wecom_msg_exec on public.wecom_messages(assigned_exec_id, handled_status, msgtime desc);
create index if not exists idx_wecom_msg_seq on public.wecom_messages(seq desc);

comment on table public.wecom_messages is
  '企业微信会话存档消息(CEO 2026-07-26):自建拉取器解密后落库 → 复用邮件归纳引擎做分类/摘要/绑PO/重点监控。';

alter table public.wecom_messages enable row level security;
drop policy if exists wecom_msg_read on public.wecom_messages;
create policy wecom_msg_read on public.wecom_messages for select to authenticated using (true);
grant select on public.wecom_messages to authenticated;
