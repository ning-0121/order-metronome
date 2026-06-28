-- ===== 20260628 采购流 Step A:原辅料单"提交采购" + 已交样标记 =====
-- 给 materials_bom 增列,支撑「业务提交原辅料单 → 流转采购」的起点动作 + 样品标记。
-- 仅加列、幂等,不动现有数据;getBomItems 用 select('*') 自动带新列,addBomItem 走默认值,不破坏现有读写。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行,Claude 不执行。

ALTER TABLE public.materials_bom
  ADD COLUMN IF NOT EXISTS submit_status text NOT NULL DEFAULT 'draft',   -- draft（未提交）| submitted（已交采购）
  ADD COLUMN IF NOT EXISTS submitted_at  timestamptz,                     -- 提交采购时间
  ADD COLUMN IF NOT EXISTS submitted_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,  -- 提交人
  ADD COLUMN IF NOT EXISTS sample_given  boolean NOT NULL DEFAULT false;  -- 已交样品给采购(线下)标记

COMMENT ON COLUMN public.materials_bom.submit_status IS '原辅料单提交状态:draft 未提交 / submitted 已交采购';
COMMENT ON COLUMN public.materials_bom.sample_given IS '该物料样品已线下交给采购的标记';
