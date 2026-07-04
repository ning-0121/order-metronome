-- ========================================================================
-- 采购单 · 自定义追踪提醒节点(2026-07-04)
-- ========================================================================
-- 用户拍板:采购给每张采购单自由加若干「追踪节点 + 日期」(如「催面料到货 7/10」),
-- 到日期系统提醒 → 通知采购(创建者)+ 该订单业务执行 + 该订单跟单。
-- 属采购域;数据所有权=采购创建维护;派生通知。非工艺、非18关卡(那是订单级),
-- 非 line_status(那是执行状态)——是采购私有的定制追踪,新对象成立。
-- RLS 与 purchase_orders 同口径:登录即可读写,角色校验在 action 层。纯加法。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。

CREATE TABLE IF NOT EXISTS public.po_reminders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id  uuid NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  label              text NOT NULL,                              -- 节点名「催面料到货」
  note               text,                                       -- 备注
  remind_at          date NOT NULL,                              -- 提醒日期
  status             text NOT NULL DEFAULT 'pending',            -- pending / notified / done / cancelled
  notified_at        timestamptz,
  done_at            timestamptz,
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- cron 扫「到点未提醒」用:仅 pending 行走索引
CREATE INDEX IF NOT EXISTS po_reminders_due_idx ON public.po_reminders (remind_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS po_reminders_po_idx  ON public.po_reminders (purchase_order_id);

ALTER TABLE public.po_reminders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS po_reminders_select ON public.po_reminders;
CREATE POLICY po_reminders_select ON public.po_reminders FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS po_reminders_insert ON public.po_reminders;
CREATE POLICY po_reminders_insert ON public.po_reminders FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS po_reminders_update ON public.po_reminders;
CREATE POLICY po_reminders_update ON public.po_reminders FOR UPDATE USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS po_reminders_delete ON public.po_reminders;
CREATE POLICY po_reminders_delete ON public.po_reminders FOR DELETE USING (auth.uid() IS NOT NULL);

COMMENT ON TABLE public.po_reminders IS
  '采购单自定义追踪提醒节点:采购加「节点+日期」,cron 每15分钟扫到点的 pending → 通知采购/业务/跟单,置 notified。status: pending/notified/done/cancelled。';

-- ========================================================================
-- 验证:
--   SELECT to_regclass('public.po_reminders');                          -- 期望 po_reminders
--   SELECT count(*) FROM pg_policy WHERE polrelid='public.po_reminders'::regclass;  -- 期望 4
-- 回滚:DROP TABLE public.po_reminders;
-- ========================================================================
