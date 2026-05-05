-- ═════════════════════════════════════════════════════════════════
-- 表审计 v3.1 — 一次性只读 SQL，粘到 Supabase SQL Editor 跑
-- ═════════════════════════════════════════════════════════════════
--
-- 用法：
--   1. 打开 https://supabase.com/dashboard/project/scrtebexbxablybqpdla/sql/new
--   2. 整文件复制粘贴
--   3. Run（耗时约 5-10 秒）
--   4. Result 标签页会出现多个结果集，每个结果集复制出来贴回给我
--
-- 仅 SELECT，绝不修改数据。
-- ═════════════════════════════════════════════════════════════════


-- ═══ Result ① 全部表 + 行数 + 是否有时间字段 ═══
SELECT
  t.table_name,
  (xpath('/row/c/text()', query_to_xml(
    format('SELECT COUNT(*) AS c FROM public.%I', t.table_name),
    false, true, ''
  )))[1]::text::int AS row_count,
  EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = t.table_name AND c.column_name = 'created_at'
  ) AS has_created_at,
  EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = t.table_name AND c.column_name = 'updated_at'
  ) AS has_updated_at
FROM information_schema.tables t
WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
ORDER BY row_count DESC NULLS LAST, t.table_name;


-- ═══ Result ② 最近 30 天写入 + 最后写入时间（仅有 created_at 的表）═══
WITH base AS (
  SELECT t.table_name
  FROM information_schema.tables t
  JOIN information_schema.columns c
    ON c.table_schema = t.table_schema AND c.table_name = t.table_name
  WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    AND c.column_name = 'created_at'
)
SELECT
  table_name,
  (xpath('/row/c/text()', query_to_xml(format('SELECT COUNT(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text::int AS total,
  (xpath('/row/c/text()', query_to_xml(format('SELECT COUNT(*) AS c FROM public.%I WHERE created_at > now() - interval ''30 days''', table_name), false, true, '')))[1]::text::int AS last_30d,
  (xpath('/row/c/text()', query_to_xml(format('SELECT MAX(created_at)::text AS c FROM public.%I', table_name), false, true, '')))[1]::text AS max_created_at
FROM base
ORDER BY last_30d DESC NULLS LAST, total DESC NULLS LAST;


-- ═══ Result ③ 报价→订单→利润 数据流真实状态 ═══
SELECT 'quoter_quotes' AS table_name,
       (SELECT COUNT(*) FROM quoter_quotes) AS row_count,
       (SELECT MAX(created_at)::text FROM quoter_quotes) AS last_created
UNION ALL
SELECT 'order_financials',
       (SELECT COUNT(*) FROM order_financials),
       (SELECT MAX(created_at)::text FROM order_financials)
UNION ALL
SELECT 'profit_snapshots',
       (SELECT COUNT(*) FROM profit_snapshots),
       (SELECT MAX(created_at)::text FROM profit_snapshots)
UNION ALL
SELECT 'order_cost_baseline',
       (SELECT COUNT(*) FROM order_cost_baseline),
       (SELECT MAX(created_at)::text FROM order_cost_baseline);

-- ③.1 orders 是否已经有指向 quoter_quotes 的外键字段
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema='public' AND table_name='orders'
  AND (column_name ILIKE '%quote%' OR column_name ILIKE '%source%')
ORDER BY column_name;


-- ═══ Result ④ customer 三表关系 ═══
SELECT 'customers (主档)' AS tbl, COUNT(*) AS rows FROM customers
UNION ALL SELECT 'customer_memory (事件)', COUNT(*) FROM customer_memory
UNION ALL SELECT 'customer_rhythm (节奏)', COUNT(*) FROM customer_rhythm
UNION ALL SELECT 'orders 中的 distinct customer_name',
  (SELECT COUNT(DISTINCT customer_name) FROM orders WHERE customer_name IS NOT NULL);

-- ④.1 customer_memory 类别分布
SELECT category, COUNT(*) AS cnt, MAX(created_at)::text AS last_at
FROM customer_memory
GROUP BY category
ORDER BY cnt DESC;

-- ④.2 customer_rhythm 字段填充率
SELECT
  COUNT(*) AS total_rows,
  COUNT(tier) AS has_tier,
  COUNT(risk_score) AS has_risk_score,
  COUNT(total_order_count) AS has_order_count
FROM customer_rhythm;


-- ═══ Result ⑤ 用户指定的 5 张关键 GHOST 表实查 ═══
-- 先确认存在性
SELECT
  table_name,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.tables t
    WHERE t.table_schema='public' AND t.table_name = q.table_name
  ) THEN '✓存在' ELSE '❌不存在' END AS status
FROM (VALUES
  ('ai_collection_log'),
  ('ai_learning_log'),
  ('system_health_reports'),
  ('order_model_analytics'),
  ('order_model_analytics_archived_20260427'),
  ('compliance_findings')
) AS q(table_name);

-- ⑤.1 存在的表查行数与最近写入（如果某张不存在某行会报错，跳过即可）
SELECT 'ai_collection_log' AS tbl,
  (SELECT COUNT(*) FROM ai_collection_log) AS rows,
  (SELECT MAX(created_at)::text FROM ai_collection_log) AS last_at,
  (SELECT COUNT(*) FROM ai_collection_log WHERE created_at > now() - interval '30 days') AS last_30d
UNION ALL
SELECT 'system_health_reports',
  (SELECT COUNT(*) FROM system_health_reports),
  (SELECT MAX(created_at)::text FROM system_health_reports),
  (SELECT COUNT(*) FROM system_health_reports WHERE created_at > now() - interval '30 days')
UNION ALL
SELECT 'compliance_findings',
  (SELECT COUNT(*) FROM compliance_findings),
  (SELECT MAX(created_at)::text FROM compliance_findings),
  (SELECT COUNT(*) FROM compliance_findings WHERE created_at > now() - interval '30 days');


-- ═══ Result ⑥ 外键依赖图（哪些表 references 哪些表）═══
SELECT
  tc.table_name AS from_table,
  kcu.column_name AS from_column,
  ccu.table_name AS to_table,
  ccu.column_name AS to_column
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name
  AND ccu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'public'
ORDER BY ccu.table_name, tc.table_name;


-- ═══ Result ⑦ 全部表清单（包含归档表）═══
SELECT
  table_name,
  CASE
    WHEN table_name LIKE '%_archived_%' THEN '📦已归档'
    ELSE '✓活跃'
  END AS status
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY status DESC, table_name;
