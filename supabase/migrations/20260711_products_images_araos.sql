-- 产品多角度图 + 来源标记（供 araos 打样「建立产品信息」写入共享产品库）。Idempotent.
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS image_urls  text[] DEFAULT '{}';  -- 多角度产品图 URL
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS created_via text;                  -- 'araos' = 开发系统打样建款
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS source_ref  text;                  -- araos 侧引用(样单/公司)，便于溯源
