-- ========================================================================
-- 节点体系 V2 · P1b —— 节点多方确认表 milestone_confirmations
-- ========================================================================
-- 设计:docs/Designs/Milestone-V2-Departments-Redesign.md §二
-- 「节点完成 = 所有要求方确认完毕」。一节点一方一行;哪个节点要哪些方
-- 在 lib/domain/confirmationParties.ts(代码配置,不进库 —— 模板演进不用改数据)。
-- 行为:行按需懒建(首次查看/确认时补齐);确认幂等;全齐 + 节点免证据 → 自动完成。
-- 只对 V2 新订单生效(V1 节点不在配置表里,零影响)。纯加法,不动 milestones。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。
-- ========================================================================

CREATE TABLE IF NOT EXISTS public.milestone_confirmations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_id  uuid NOT NULL REFERENCES public.milestones(id) ON DELETE CASCADE,
  order_id      uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  step_key      text NOT NULL,                      -- 冗余存,便于按节点查(与 milestone 同步写入)
  party_key     text NOT NULL,                      -- sales_exec / finance / production / procurement / qc
  party_label   text NOT NULL,                      -- 业务执行 / 财务 / 生产部 / 采购部 / 生产部QC
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed')),
  confirmed_by  uuid REFERENCES auth.users(id),
  confirmed_at  timestamptz,
  note          text,                               -- 确认留言(如「尾料已清点归库 3 项」)
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE(milestone_id, party_key)
);

CREATE INDEX IF NOT EXISTS idx_mconf_milestone ON public.milestone_confirmations(milestone_id);
CREATE INDEX IF NOT EXISTS idx_mconf_order ON public.milestone_confirmations(order_id, status);

ALTER TABLE public.milestone_confirmations ENABLE ROW LEVEL SECURITY;
-- 登录可读/可建/可改;「谁能代表哪一方确认」按角色在 server action 里把关
DROP POLICY IF EXISTS mconf_sel ON public.milestone_confirmations;
CREATE POLICY mconf_sel ON public.milestone_confirmations FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS mconf_ins ON public.milestone_confirmations;
CREATE POLICY mconf_ins ON public.milestone_confirmations FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS mconf_upd ON public.milestone_confirmations;
CREATE POLICY mconf_upd ON public.milestone_confirmations FOR UPDATE USING (auth.uid() IS NOT NULL);

COMMENT ON TABLE public.milestone_confirmations IS
  'V2节点多方确认(P1b)。一节点一方一行;要求哪些方在 lib/domain/confirmationParties.ts;全部confirmed=节点可完成(免证据节点自动完成)。';

-- ========================================================================
-- 验证(执行后逐条跑,期望值见注释)
-- ========================================================================
-- ① 期望 1 行(表在):
-- SELECT table_name FROM information_schema.tables WHERE table_name='milestone_confirmations';
-- ② 期望 3 行(RLS 策略齐):
-- SELECT polname FROM pg_policy WHERE polrelid='public.milestone_confirmations'::regclass;
-- ③ 期望 1 行(唯一约束在):
-- SELECT conname FROM pg_constraint WHERE conrelid='public.milestone_confirmations'::regclass AND contype='u';

-- ========================================================================
-- 回滚
-- ========================================================================
-- DROP TABLE IF EXISTS public.milestone_confirmations;
