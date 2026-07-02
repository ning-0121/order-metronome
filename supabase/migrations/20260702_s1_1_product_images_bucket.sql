-- ========================================================================
-- S1.1 产品图公开桶 — 富录入表每款上传产品图
-- ========================================================================
-- 产品图不敏感 → 独立公开桶(不混进私有 order-docs,避免签名 URL 过期)。
-- 登录用户可上传;任何人可读(公开)。图片 URL 存 order_line_items.image_url。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。
-- ========================================================================

-- 建公开桶
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;

-- 登录用户可上传到该桶
drop policy if exists "product_images_insert" on storage.objects;
create policy "product_images_insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'product-images');

-- 公开读
drop policy if exists "product_images_select" on storage.objects;
create policy "product_images_select" on storage.objects
  for select using (bucket_id = 'product-images');

-- ========================================================================
-- 验证(期望:桶存在且 public=true)
-- ========================================================================
-- select id, public from storage.buckets where id='product-images';

-- ========================================================================
-- 回滚
-- ========================================================================
-- drop policy if exists "product_images_insert" on storage.objects;
-- drop policy if exists "product_images_select" on storage.objects;
-- delete from storage.buckets where id='product-images';
