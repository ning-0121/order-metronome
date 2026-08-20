-- ============================================================
-- 出货审批外部审批人落库(2026-08-20 集成审计:外部路径「谁放的货」答不出)
-- 财务系统回传的 decided_by = 真实 auth.uid(财务侧 approve 路由忽略客户端传值,铁律合规),
-- 但节拍器侧从未落库:finance_sign_id 外部路径恒 NULL,只留了个自报姓名字符串。
-- 加 text 列(财务系统用户 ID 与节拍器不同 auth,不能 FK)。可逆:DROP COLUMN。
-- ============================================================
ALTER TABLE public.shipment_confirmations
  ADD COLUMN IF NOT EXISTS finance_decided_by text;
COMMENT ON COLUMN public.shipment_confirmations.finance_decided_by
  IS '外部财务系统审批人 auth.uid(回传 decided_by;站内审批用 finance_sign_id)';
