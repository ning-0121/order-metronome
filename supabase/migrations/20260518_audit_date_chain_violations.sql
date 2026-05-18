-- ════════════════════════════════════════════════════════════════════════
-- 2026-05-18 — 审计现存订单的日期链违规
--
-- 用途：找出所有 ETA<ETD / ETD<factory_date / factory_date<order_date 的订单。
--      不自动修复 — 让 admin 手工核实后逐个修正（避免改错日期）。
-- ════════════════════════════════════════════════════════════════════════

-- 1. 列出所有日期链异常订单（按严重程度排序）
SELECT
  o.order_no,
  o.lifecycle_status,
  o.order_date::date AS order_date,
  o.factory_date::date AS factory_date,
  o.etd::date AS etd,
  o.warehouse_due_date::date AS eta,
  o.cancel_date::date AS cancel_date,
  CASE
    WHEN o.factory_date < o.order_date THEN '出厂日早于下单日'
    WHEN o.etd < o.factory_date THEN 'ETD 早于出厂日'
    WHEN o.warehouse_due_date < o.etd THEN 'ETA 早于 ETD  (你截图的 bug)'
    WHEN o.cancel_date < o.warehouse_due_date THEN 'Cancel Date 早于 ETA'
    ELSE '其他逆序'
  END AS violation
FROM public.orders o
WHERE
  (o.factory_date IS NOT NULL AND o.order_date IS NOT NULL AND o.factory_date < o.order_date)
  OR (o.etd IS NOT NULL AND o.factory_date IS NOT NULL AND o.etd < o.factory_date)
  OR (o.warehouse_due_date IS NOT NULL AND o.etd IS NOT NULL AND o.warehouse_due_date < o.etd)
  OR (o.cancel_date IS NOT NULL AND o.warehouse_due_date IS NOT NULL AND o.cancel_date < o.warehouse_due_date)
ORDER BY o.created_at DESC;

-- 2. 计数总览
SELECT
  COUNT(*) FILTER (WHERE factory_date < order_date)                         AS "出厂<下单",
  COUNT(*) FILTER (WHERE etd < factory_date)                                AS "ETD<出厂",
  COUNT(*) FILTER (WHERE warehouse_due_date < etd)                          AS "ETA<ETD (主要 bug)",
  COUNT(*) FILTER (WHERE cancel_date < warehouse_due_date)                  AS "Cancel<ETA",
  COUNT(*) AS total_orders
FROM public.orders;
