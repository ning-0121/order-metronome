-- ===== 2026-07-13 物流出运子任务(送仓/装柜/报关/内陆送货)=====
-- 物流部(秦增超)在出运节点下逐项跟:出口=装柜/报关放行/拖柜送港/开船;国内=内陆送货/送仓签收。
-- 每项可标完成 + 时间 + 备注。按 order + task_key 唯一,幂等初始化。

CREATE TABLE IF NOT EXISTS public.logistics_subtasks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  task_key   text NOT NULL,
  label      text NOT NULL,
  seq        int  NOT NULL DEFAULT 0,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
  done_at    timestamptz,
  done_by    uuid,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_id, task_key)
);
CREATE INDEX IF NOT EXISTS idx_logistics_subtasks_order ON public.logistics_subtasks(order_id);

-- RLS:非敏感(任务状态,无金额)→ SELECT 登录可读;写走 service-role + action 层门禁(仅物流/管理)。
ALTER TABLE public.logistics_subtasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ls_select ON public.logistics_subtasks;
CREATE POLICY ls_select ON public.logistics_subtasks FOR SELECT USING (auth.uid() IS NOT NULL);

COMMENT ON TABLE public.logistics_subtasks IS
  '物流出运子任务(装柜/报关/内陆送货/送仓等)。按订单出运方式初始化;物流逐项标完成。写走 service-role+action门禁。';

-- 验证:
-- SELECT column_name FROM information_schema.columns WHERE table_name='logistics_subtasks';
-- SELECT relrowsecurity FROM pg_class WHERE relname='logistics_subtasks';
