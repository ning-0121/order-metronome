-- ============================================================
-- Phase 0b · QIMO OS · Contract API 日志两表
-- Supabase: scrtebexbxablybqpdla（QIMO，Enterprise Host）
-- Date: 2026-06-29
-- 设计依据: docs/integration/07-Phase-0b-Contract-API-Design.md
--           docs/integration/08-phase-0b-migration-drafts.md
-- ------------------------------------------------------------
-- 范围: 仅新增 2 张表 —— contract_access_log · contract_request_log。
-- 性质: 纯新增 · service-role 写 · RLS 启用(0 策略=默认拒绝 anon/authenticated) ·
--       无跨表 FK · 一键回滚(DROP) ·
--       不动任何现有表 / 不动 0a 列 / 不改任何现有 RLS。
-- 与 0a 的有意差异: 这是新日志表 —— 带 PK + 索引（request_id PK = 幂等机制本身）。
--                   仍无跨表 FK。
-- 写入时机: access_log 在 4 个只读端点上线即写；request_log 框架就位，
--           写入端点 handoff/payment-status 激活在 0c/0d（0b 不写它）。
-- ============================================================

-- ===== 表 1: contract_access_log（访问审计，摘要）=====
CREATE TABLE IF NOT EXISTS public.contract_access_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  key_id           text NOT NULL,              -- 消费方身份 'finance'|'araos'（非密钥）
  scope            text,                       -- 'finance.read'|'commercial.read'|...
  method           text NOT NULL,              -- GET|POST
  route            text NOT NULL,              -- 路由模板 '/api/contract/v1/orders/:id'
  qimo_entity_type text,                       -- customer|order|quote|order-snapshot|handoff|payment-status
  qimo_entity_id   uuid,                       -- 目标企业 id（非 FK，仅留痕）
  request_id       text,                       -- 写入类带；读类可空
  status_code      int  NOT NULL,              -- HTTP 状态
  outcome          text NOT NULL,              -- ok|unauthorized|forbidden|not_found|rate_limited|idempotent_replay|error
  error_code       text,                       -- 机器码（可空）
  ip               text,                       -- best-effort x-forwarded-for
  latency_ms       int
);
CREATE INDEX IF NOT EXISTS idx_contract_access_log_occurred ON public.contract_access_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_contract_access_log_key      ON public.contract_access_log (key_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_contract_access_log_entity   ON public.contract_access_log (qimo_entity_id);
ALTER TABLE public.contract_access_log ENABLE ROW LEVEL SECURITY;  -- service-role 写；无策略=默认拒绝 anon/authenticated

COMMENT ON TABLE  public.contract_access_log IS
  'Phase0b: Contract API 访问审计日志（仅摘要，不存请求 body / 财务原值）。service-role 写入，RLS 默认拒绝直连访问。';
COMMENT ON COLUMN public.contract_access_log.key_id IS '消费方身份标识（finance|araos），非密钥本身。';
COMMENT ON COLUMN public.contract_access_log.qimo_entity_id IS '目标企业 id（uuid 留痕，非 FK，不随实体删除级联）。';
COMMENT ON COLUMN public.contract_access_log.outcome IS 'ok|unauthorized|forbidden|not_found|rate_limited|idempotent_replay|error。';

-- ===== 表 2: contract_request_log（写入幂等存储）=====
CREATE TABLE IF NOT EXISTS public.contract_request_log (
  request_id       text PRIMARY KEY,           -- 幂等键（调用方提供，全局唯一）
  key_id           text NOT NULL,              -- 消费方
  route            text NOT NULL,              -- 写入端点
  request_hash     text NOT NULL,              -- sha256(body)；同 id 不同 hash => 409 冲突
  response_summary jsonb,                       -- 首次响应封套（仅 id/status，无财务原值）供重放
  status_code      int  NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL DEFAULT (now() + interval '7 days')  -- TTL，供清理
);
CREATE INDEX IF NOT EXISTS idx_contract_request_log_expires ON public.contract_request_log (expires_at);
ALTER TABLE public.contract_request_log ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE  public.contract_request_log IS
  'Phase0b: Contract API 写入幂等存储（request_id 唯一→检测重放/冲突）。0b 仅建表；写入端点 handoff/payment-status 激活在 0c/0d。service-role 写，RLS 默认拒绝。';
COMMENT ON COLUMN public.contract_request_log.request_hash IS 'sha256(请求 body)；同 request_id 不同 hash 视为冲突(409)。';
COMMENT ON COLUMN public.contract_request_log.response_summary IS '首次响应封套(仅 id/status)，用于幂等重放；不存入站财务原值。';

-- ============================================================
-- 验证 SQL（数据库门禁 — 在 Supabase SQL Editor 单独运行）
-- ------------------------------------------------------------
-- [1] 两表存在（期望 2 行）
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema='public' AND table_name IN ('contract_access_log','contract_request_log')
-- ORDER BY table_name;
--
-- [2] 列 + 类型（期望 22 行：access_log 14 + request_log 8）
-- SELECT table_name, column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema='public' AND table_name IN ('contract_access_log','contract_request_log')
-- ORDER BY table_name, ordinal_position;
--
-- [3] 主键正确 + 无 FK（access_log PK(id) · request_log PK(request_id) · 无 contype='f'）
-- SELECT t.relname AS tbl, con.conname, con.contype,
--        array_agg(a.attname ORDER BY a.attnum) AS cols
-- FROM pg_constraint con
-- JOIN pg_class t ON t.oid=con.conrelid
-- JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=ANY(con.conkey)
-- WHERE t.relnamespace='public'::regnamespace
--   AND t.relname IN ('contract_access_log','contract_request_log')
-- GROUP BY t.relname, con.conname, con.contype
-- ORDER BY t.relname, con.contype;
--
-- [4] RLS 启用 + 策略数（期望: 两行 rls_enabled=true, policy_count=0）
-- SELECT c.relname AS tbl, c.relrowsecurity AS rls_enabled,
--        (SELECT count(*) FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname) AS policy_count
-- FROM pg_class c
-- WHERE c.relnamespace='public'::regnamespace
--   AND c.relname IN ('contract_access_log','contract_request_log')
-- ORDER BY c.relname;
--
-- [5] 索引存在（期望: access_log pkey+occurred+key+entity；request_log pkey(unique request_id)+expires）
-- SELECT t.relname AS tbl, i.relname AS index_name, ix.indisunique AS is_unique
-- FROM pg_index ix
-- JOIN pg_class t ON t.oid=ix.indrelid
-- JOIN pg_class i ON i.oid=ix.indexrelid
-- WHERE t.relnamespace='public'::regnamespace
--   AND t.relname IN ('contract_access_log','contract_request_log')
-- ORDER BY t.relname, i.relname;
--
-- [6] 表注释存在（期望 2 行有注释）
-- SELECT c.relname AS tbl, obj_description(c.oid) AS table_comment
-- FROM pg_class c
-- WHERE c.relnamespace='public'::regnamespace
--   AND c.relname IN ('contract_access_log','contract_request_log')
-- ORDER BY c.relname;
--
-- [7] 无跨表 FK（期望 0 行）
-- SELECT con.conname, t.relname FROM pg_constraint con
-- JOIN pg_class t ON t.oid=con.conrelid
-- WHERE con.contype='f' AND t.relnamespace='public'::regnamespace
--   AND t.relname IN ('contract_access_log','contract_request_log');
--
-- [8] 两表初始为空（期望各 0）
-- SELECT 'contract_access_log' AS tbl, count(*) AS rows FROM public.contract_access_log
-- UNION ALL
-- SELECT 'contract_request_log', count(*) FROM public.contract_request_log;
--
-- [9] 不外泄（旁证：[4] RLS 启用 + 0 策略 = 默认拒绝 anon/authenticated）
-- [10] 零现有表影响（人工对照：本文件只含 2 个 CREATE TABLE + 索引 + RLS + 注释，无任何 ALTER 现有表 / 无 0a 列改动）
-- ============================================================

-- ============================================================
-- 回滚 SQL（如需撤销，单独运行；本文件正常执行不含回滚）
-- ------------------------------------------------------------
-- DROP TABLE IF EXISTS public.contract_access_log;
-- DROP TABLE IF EXISTS public.contract_request_log;
-- （DROP TABLE 级联清除索引/约束/注释；零业务表受影响。）
-- ============================================================
