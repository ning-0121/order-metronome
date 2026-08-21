-- ========================================================================
-- 逾期处置(delivery resolution)—— 让「真超期」有出口,而不是一直挂在预警里
-- ========================================================================
-- CEO 2026-08-20:「我们是来进行订单推进的,不只是停在预警上」。
--
-- 现状:交期日已过的单在「真超期(要行动)」列表里只有「详情›」一个链接。
--   提示写着「催工厂 / 改期 / 跟客户」,但一个都点不了。
--   而已有的 delay_requests 改的是**节点 due_at** —— 批了节点不红了,
--   订单交期(factory_date/etd)照旧过期,那一行还在。业务跟客户谈成新交期,
--   系统里没有地方录 → 红条永远挂着。
--
-- 本表是**决策记录 + 审批载体**,不是第二个交期真相:
--   交期真相始终在 orders.factory_date / orders.etd。
--   本表批准后由 action 写回 orders,并记 applied_at。
--
-- 审批:订单经理 → 财务 两级(CEO 2026-08-20 指定)。
--   状态机 pending → om_approved → approved;任一级可 rejected。
--   两级都过才写回 orders —— 交期承诺与钱(快船费/折让/弃货损失)都要有人认。
-- ========================================================================

CREATE TABLE IF NOT EXISTS public.order_delivery_resolutions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,

  -- 处置方式(CEO 拍板的 5 种 + 其他)
  --   reschedule   客户同意改期 → 换新交期
  --   expedite     快船/空运赶 → 交期不变,吃运费
  --   discount     打折发货 → 让价换接收
  --   abandon      弃货/取消
  --   partial_ship 分批出 → 已好的先走,余量改期
  --   other        其他(必须在 reason 里说清)
  resolution_type text NOT NULL CHECK (resolution_type IN
    ('reschedule','expedite','discount','abandon','partial_ship','other')),

  -- 新的交期承诺(reschedule / partial_ship 用;其余可空)
  new_factory_date date,
  new_etd date,

  -- 客户答复留痕 —— 「跟客户谈过」必须留下证据,不能只有一句口头
  customer_response text NOT NULL,          -- 客户怎么答复的
  customer_confirmed_at date,               -- 客户确认日期
  evidence_path text,                       -- 邮件/聊天截图(order-docs 路径)

  -- 财务口径的代价(CEO:落进财务口径)
  cost_amount numeric(14,2),                -- 额外成本或折让金额
  cost_currency text DEFAULT 'CNY',
  cost_kind text CHECK (cost_kind IS NULL OR cost_kind IN
    ('air_freight','express_sea','discount','write_off','other')),

  reason text NOT NULL,                     -- 为什么选这个处置

  -- 两级审批
  status text NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','om_approved','approved','rejected')),
  om_approved_by uuid REFERENCES auth.users(id),
  om_approved_at timestamptz,
  om_note text,
  finance_approved_by uuid REFERENCES auth.users(id),
  finance_approved_at timestamptz,
  finance_note text,
  rejected_by uuid REFERENCES auth.users(id),
  rejected_at timestamptz,
  reject_reason text,

  applied_at timestamptz,                   -- 批准后写回 orders 的时刻(幂等闸)
  requested_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.order_delivery_resolutions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "odr_authenticated" ON public.order_delivery_resolutions;
CREATE POLICY "odr_authenticated" ON public.order_delivery_resolutions
  FOR ALL USING (auth.uid() IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_odr_order ON public.order_delivery_resolutions(order_id);
-- 局部索引:审批中心只查未结的,不扫历史
CREATE INDEX IF NOT EXISTS idx_odr_open ON public.order_delivery_resolutions(status)
  WHERE status IN ('pending','om_approved');
-- 一张单同时只允许一个未结处置(防重复发起/审批打架)
CREATE UNIQUE INDEX IF NOT EXISTS uq_odr_one_open_per_order
  ON public.order_delivery_resolutions(order_id)
  WHERE status IN ('pending','om_approved');

-- ========================================================================
-- 验证
-- ========================================================================
-- ① 期望建表成功且有 3 个索引:
-- SELECT indexname FROM pg_indexes WHERE tablename='order_delivery_resolutions';
-- ② 唯一约束生效(同一单插第二条 pending 应报 duplicate key):
-- INSERT ... 两次 status='pending' 同 order_id → 第二次失败
--
-- ========================================================================
-- 回滚
-- ========================================================================
-- DROP TABLE IF EXISTS public.order_delivery_resolutions;
