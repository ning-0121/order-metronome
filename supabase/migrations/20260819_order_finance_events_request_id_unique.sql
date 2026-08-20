-- ============================================================
-- 修:order_finance_events.request_id 无唯一约束(2026-08-19 集成审计)
--
-- 现状:finance-callback 的资金进度事件(payment.completed 等)幂等纯靠
-- select-then-insert,5 分钟签名窗口内并发重放两次 → 两次 select 都查不到 →
-- 双插 → applyProcurementPayment 把对账已付累加两遍,付款申请可能被误标 paid。
-- 这是入站侧唯一的真实资金重复计风险。
--
-- 存量核查(2026-08-19):58 行,request_id 零重复 → 可安全建唯一索引。
-- 部分索引(WHERE request_id IS NOT NULL):历史无 request_id 的行不受影响。
-- 配套代码:finance-callback 改 upsert onConflict request_id ignoreDuplicates,
-- 并只在真实插入(非冲突吞并)时执行 applyProcurementPayment。
-- 可逆:DROP INDEX 即回滚。
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS order_finance_events_request_id_uniq
  ON public.order_finance_events (request_id)
  WHERE request_id IS NOT NULL;
