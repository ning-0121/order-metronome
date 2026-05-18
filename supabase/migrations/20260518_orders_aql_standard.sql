-- ════════════════════════════════════════════════════════════════════════
-- 2026-05-18 — 给 orders 加 AQL 验货标准字段
--
-- 业务背景：AQL 标准（1.5 / 2.5 / 4.0 / 客户指定）是合同条款的一部分，
--   工厂大货生产时就要按此标准排产。原来系统在 final_qc_check checklist
--   才录入 AQL，等于到了尾查才确定标准 — 工厂可能用错标准生产。
--
-- 修复：订单创建时强制录入 AQL，下游 final_qc_check 自动 prefill。
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS aql_standard text
  CHECK (aql_standard IS NULL OR aql_standard IN ('1.5', '2.5', '4.0', 'customer_specified'));

COMMENT ON COLUMN public.orders.aql_standard IS
  'AQL 验货标准（合同条款）：1.5 (严) / 2.5 (标准) / 4.0 (松) / customer_specified (客户指定)。
   订单创建时录入，final_qc_check 节点用此 prefill。';

-- 验证 SQL（手动跑）
-- SELECT aql_standard, COUNT(*) FROM orders GROUP BY aql_standard;
