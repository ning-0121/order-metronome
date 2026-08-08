-- R1-D:order_logs.payload text → jsonb(与 milestone_logs 对齐)。
-- 统一审计信封写进 text 列被存成字符串,反查链读出来是 string 不是对象 ——
-- 生产 trace 验证时抓到的 schema 漂移。存量 36 行已验证全部为合法 JSON。
alter table public.order_logs
  alter column payload type jsonb using nullif(payload, '')::jsonb;
