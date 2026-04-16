-- ════════════════════════════════════════════════════════════
-- 审计：采购订单下达节点下"不是 Excel/PDF"的附件
-- ════════════════════════════════════════════════════════════
--
-- 用法：
--   1. 登录 Supabase Dashboard → SQL Editor
--   2. 粘贴本文件内容 → Run
--   3. 查看结果，找出需要让采购重新上传的订单
--
-- 场景：2026-04-15 发现有订单把微信截图当采购单上传了（.png），
-- 此脚本帮你一次性找出所有类似历史数据。
-- ════════════════════════════════════════════════════════════

-- 结果一：逐条列出问题附件
SELECT
  o.order_no                                                     AS "订单号",
  o.customer_name                                                AS "客户",
  o.lifecycle_status                                             AS "订单状态",
  oa.file_name                                                   AS "文件名",
  LOWER(split_part(oa.file_name, '.', -1))                       AS "扩展名",
  oa.file_type                                                   AS "file_type",
  ROUND(oa.file_size / 1024.0, 1)                                AS "KB",
  p.name                                                         AS "上传人",
  p.email                                                        AS "上传人邮箱",
  TO_CHAR(oa.created_at AT TIME ZONE 'Asia/Shanghai',
          'YYYY-MM-DD HH24:MI')                                  AS "上传时间",
  oa.file_url                                                    AS "文件链接"
FROM order_attachments oa
JOIN milestones m ON m.id = oa.milestone_id
JOIN orders o ON o.id = oa.order_id
LEFT JOIN profiles p ON p.user_id = oa.uploaded_by
WHERE m.step_key = 'procurement_order_placed'
  AND LOWER(split_part(oa.file_name, '.', -1))
      NOT IN ('xlsx', 'xls', 'pdf')
ORDER BY oa.created_at DESC;

-- ────────────────────────────────────────────────────────────
-- 结果二：按订单汇总（快速看涉及哪些订单 + 附件计数）
-- ────────────────────────────────────────────────────────────

SELECT
  o.order_no                          AS "订单号",
  o.customer_name                     AS "客户",
  o.lifecycle_status                  AS "订单状态",
  COUNT(*)                            AS "问题附件数",
  STRING_AGG(
    oa.file_name,
    E'\n' ORDER BY oa.created_at
  )                                   AS "文件列表"
FROM order_attachments oa
JOIN milestones m ON m.id = oa.milestone_id
JOIN orders o ON o.id = oa.order_id
WHERE m.step_key = 'procurement_order_placed'
  AND LOWER(split_part(oa.file_name, '.', -1))
      NOT IN ('xlsx', 'xls', 'pdf')
GROUP BY o.id, o.order_no, o.customer_name, o.lifecycle_status
ORDER BY COUNT(*) DESC;

-- ────────────────────────────────────────────────────────────
-- 结果三：按扩展名分布（了解问题规模）
-- ────────────────────────────────────────────────────────────

SELECT
  LOWER(split_part(oa.file_name, '.', -1)) AS "扩展名",
  COUNT(*)                                 AS "附件数",
  COUNT(DISTINCT oa.order_id)              AS "涉及订单数"
FROM order_attachments oa
JOIN milestones m ON m.id = oa.milestone_id
WHERE m.step_key = 'procurement_order_placed'
  AND LOWER(split_part(oa.file_name, '.', -1))
      NOT IN ('xlsx', 'xls', 'pdf')
GROUP BY LOWER(split_part(oa.file_name, '.', -1))
ORDER BY COUNT(*) DESC;
