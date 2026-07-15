-- ===== 2026-07-13 物流子任务加出货凭证附件(多张)=====
-- 出运子任务(装柜/报关/内陆送货/送仓)每项可上传多张出货凭证(装柜照/报关单/提单/签收单等)。
-- attachments = [{name, url}] jsonb;文件传公开桶 product-images(与排版稿同款,可直接查看)。

ALTER TABLE public.logistics_subtasks
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 验证:
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name='logistics_subtasks' AND column_name='attachments';   期望 jsonb
