-- ===== 20260615 user_role enum 补两个经理角色（2026版组织）=====
-- 背景：profiles.role / milestones.owner_role 均为 enum `user_role`。
-- 新增订单管理经理 / 采购经理需先进 enum，否则 /admin/users 配角色报 "更新用户角色失败"
-- （真实错误 22P02 invalid input value for enum user_role 被 friendlyError 包掉）。
-- 已于 2026-06-15 在生产执行；本文件为 repo 存档。
-- 注意：enum ADD VALUE 须独立语句、不可与"使用该值"同事务；IF NOT EXISTS 幂等。

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'order_manager';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'procurement_manager';
