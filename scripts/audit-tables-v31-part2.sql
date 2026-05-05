-- ═════════════════════════════════════════════════════════════════
-- 表审计 v3.1 — 后续 result（防御式版本）
-- ═════════════════════════════════════════════════════════════════
--
-- 用途：v31.sql 第 67 行因 order_cost_baseline 不存在而崩，
--       这版把所有硬编码 FROM 改成"表存在才查"的安全模式。
-- 仅 SELECT，绝不写。
--
-- 用法：粘到 Supabase SQL Editor，Run，把 5 个 result 贴回来。
-- ═════════════════════════════════════════════════════════════════


-- ═══ Result ③ 报价→订单→利润 链路（防御式）═══
-- 表不存在 → row_count = -1（区分 0 和"不存在"）
WITH targets(t) AS (VALUES
  ('quoter_quotes'),
  ('order_financials'),
  ('profit_snapshots'),
  ('order_cost_baseline'),
  ('quoter_cmt_training_samples'),
  ('order_root_causes')
)
SELECT
  t AS table_name,
  CASE
    WHEN EXISTS (SELECT 1 FROM information_schema.tables i
                 WHERE i.table_schema='public' AND i.table_name = t)
    THEN (xpath('/row/c/text()', query_to_xml(
      format('SELECT COUNT(*) AS c FROM public.%I', t), false, true, ''
    )))[1]::text::int
    ELSE -1  -- -1 表示"表不存在"
  END AS row_count,
  CASE
    WHEN EXISTS (SELECT 1 FROM information_schema.tables i
                 WHERE i.table_schema='public' AND i.table_name = t)
    AND  EXISTS (SELECT 1 FROM information_schema.columns c
                 WHERE c.table_schema='public' AND c.table_name = t AND c.column_name='created_at')
    THEN (xpath('/row/c/text()', query_to_xml(
      format('SELECT MAX(created_at)::text AS c FROM public.%I', t), false, true, ''
    )))[1]::text
    ELSE NULL
  END AS last_created
FROM targets;

-- ③.1 orders 是否有外键字段指向 quoter_quotes
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema='public' AND table_name='orders'
  AND (column_name ILIKE '%quote%' OR column_name ILIKE '%source%')
ORDER BY column_name;


-- ═══ Result ④ customer 三表关系（防御式）═══
WITH targets(t) AS (VALUES
  ('customers'),
  ('customer_memory'),
  ('customer_rhythm')
)
SELECT
  t AS table_name,
  CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables i
                    WHERE i.table_schema='public' AND i.table_name=t)
    THEN (xpath('/row/c/text()', query_to_xml(
      format('SELECT COUNT(*) AS c FROM public.%I', t), false, true, ''
    )))[1]::text::int
    ELSE -1
  END AS row_count
FROM targets
UNION ALL
SELECT 'orders 中的 distinct customer_name', COUNT(DISTINCT customer_name)
FROM orders
WHERE customer_name IS NOT NULL;

-- ④.1 customer_memory 类别分布（如果表存在）
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


-- ═══ Result ⑤ 用户重点关注的 5 张幽灵表（防御式）═══
WITH targets(t) AS (VALUES
  ('ai_collection_log'),
  ('ai_learning_log'),
  ('system_health_reports'),
  ('order_model_analytics'),
  ('order_model_analytics_archived_20260427'),
  ('compliance_findings')
)
SELECT
  t AS table_name,
  CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables i
                    WHERE i.table_schema='public' AND i.table_name=t)
    THEN '✓存在' ELSE '❌不存在' END AS status,
  CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables i
                    WHERE i.table_schema='public' AND i.table_name=t)
    THEN (xpath('/row/c/text()', query_to_xml(
      format('SELECT COUNT(*) AS c FROM public.%I', t), false, true, ''
    )))[1]::text::int
    ELSE -1 END AS row_count,
  CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables i
                    WHERE i.table_schema='public' AND i.table_name=t)
    AND  EXISTS (SELECT 1 FROM information_schema.columns c
                 WHERE c.table_schema='public' AND c.table_name=t AND c.column_name='created_at')
    THEN (xpath('/row/c/text()', query_to_xml(
      format('SELECT MAX(created_at)::text AS c FROM public.%I', t), false, true, ''
    )))[1]::text
    ELSE NULL END AS last_at,
  CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables i
                    WHERE i.table_schema='public' AND i.table_name=t)
    AND  EXISTS (SELECT 1 FROM information_schema.columns c
                 WHERE c.table_schema='public' AND c.table_name=t AND c.column_name='created_at')
    THEN (xpath('/row/c/text()', query_to_xml(
      format('SELECT COUNT(*) AS c FROM public.%I WHERE created_at > now() - interval ''30 days''', t), false, true, ''
    )))[1]::text::int
    ELSE -1 END AS last_30d
FROM targets;


-- ═══ Result ⑥ 外键依赖图 ═══
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


-- ═══ Result ⑦ 全部表清单（含归档表）═══
SELECT
  table_name,
  CASE
    WHEN table_name LIKE '%_archived_%' THEN '📦已归档'
    ELSE '✓活跃'
  END AS status
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY status DESC, table_name;
