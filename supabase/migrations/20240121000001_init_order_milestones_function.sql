-- 系统级函数：初始化订单里程碑
-- 使用 SECURITY DEFINER 绕过 RLS，用于系统初始化
-- 不允许用户直接调用，只能通过 Server Action 调用

-- 删除旧函数（如果存在）
DROP FUNCTION IF EXISTS public.init_order_milestones(uuid, jsonb);

-- 创建函数：接收订单ID和里程碑数据JSON
CREATE OR REPLACE FUNCTION public.init_order_milestones(
  _order_id uuid,
  _milestones_data jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  milestone_item jsonb;
  milestone_status text;
  milestone_owner_role text;
  milestone_idx integer := 0;
BEGIN
  -- 1. 校验订单存在
  IF NOT EXISTS (SELECT 1 FROM public.orders WHERE id = _order_id) THEN
    RAISE EXCEPTION 'Order not found: %', _order_id;
  END IF;

  -- 2. 遍历里程碑数据并插入
  FOR milestone_item IN SELECT * FROM jsonb_array_elements(_milestones_data)
  LOOP
    milestone_idx := milestone_idx + 1;
    
    -- 提取字段
    milestone_status := COALESCE(
      milestone_item->>'status',
      CASE 
        WHEN milestone_item->>'step_key' = 'po_confirmed' THEN 'in_progress'
        ELSE 'pending'
      END
    );
    
    milestone_owner_role := milestone_item->>'owner_role';
    
    -- 映射角色值：logistics -> logistics (如果数据库支持) 或 admin
    -- qc -> qc (如果数据库支持) 或 quality
    IF milestone_owner_role = 'logistics' THEN
      -- 检查枚举是否支持 logistics
      IF EXISTS (
        SELECT 1 FROM pg_enum 
        WHERE enumlabel = 'logistics' 
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'user_role')
      ) THEN
        milestone_owner_role := 'logistics';
      ELSE
        milestone_owner_role := 'admin';
      END IF;
    ELSIF milestone_owner_role = 'qc' THEN
      -- 检查枚举是否支持 qc
      IF EXISTS (
        SELECT 1 FROM pg_enum 
        WHERE enumlabel = 'qc' 
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'user_role')
      ) THEN
        milestone_owner_role := 'qc';
      ELSE
        milestone_owner_role := 'quality';
      END IF;
    END IF;
    
    -- 3. 插入里程碑（SECURITY DEFINER 绕过 RLS）
    -- 使用动态检查表结构，兼容两种表定义
    -- 检查 owner_role 列的类型
    IF EXISTS (
      SELECT 1 
      FROM information_schema.columns c
      JOIN pg_type t ON c.udt_name = t.typname
      WHERE c.table_schema = 'public' 
      AND c.table_name = 'milestones' 
      AND c.column_name = 'owner_role'
      AND t.typname = 'user_role'
    ) THEN
      -- 表使用枚举类型 user_role（migration.sql）
      IF EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'milestones' 
        AND column_name = 'sequence_number'
      ) THEN
        -- 有 sequence_number 字段
        INSERT INTO public.milestones (
          order_id, step_key, name, owner_role, owner_user_id,
          planned_at, due_at, status, is_critical, evidence_required, notes, sequence_number
        ) VALUES (
          _order_id,
          milestone_item->>'step_key',
          milestone_item->>'name',
          milestone_owner_role::user_role,
          NULLIF(milestone_item->>'owner_user_id', 'null')::uuid,
          (milestone_item->>'planned_at')::timestamptz,
          (milestone_item->>'due_at')::timestamptz,
          milestone_status::milestone_status,
          COALESCE((milestone_item->>'is_critical')::boolean, false),
          COALESCE((milestone_item->>'evidence_required')::boolean, false),
          NULLIF(milestone_item->>'notes', 'null'),
          COALESCE((milestone_item->>'sequence_number')::integer, milestone_idx)
        )
        ON CONFLICT (order_id, step_key) DO NOTHING;
      ELSE
        -- 没有 sequence_number 字段
        INSERT INTO public.milestones (
          order_id, step_key, name, owner_role, owner_user_id,
          planned_at, due_at, status, is_critical, evidence_required, notes
        ) VALUES (
          _order_id,
          milestone_item->>'step_key',
          milestone_item->>'name',
          milestone_owner_role::user_role,
          NULLIF(milestone_item->>'owner_user_id', 'null')::uuid,
          (milestone_item->>'planned_at')::timestamptz,
          (milestone_item->>'due_at')::timestamptz,
          milestone_status::milestone_status,
          COALESCE((milestone_item->>'is_critical')::boolean, false),
          COALESCE((milestone_item->>'evidence_required')::boolean, false),
          NULLIF(milestone_item->>'notes', 'null')
        )
        ON CONFLICT (order_id, step_key) DO NOTHING;
      END IF;
    ELSE
      -- 表使用 text 类型（migration_milestones.sql）
      INSERT INTO public.milestones (
        order_id, step_key, name, owner_role, owner_user_id,
        planned_at, due_at, status, is_critical, evidence_required, notes
      ) VALUES (
        _order_id,
        milestone_item->>'step_key',
        milestone_item->>'name',
        milestone_owner_role, -- text 类型
        NULLIF(milestone_item->>'owner_user_id', 'null')::uuid,
        (milestone_item->>'planned_at')::timestamptz,
        (milestone_item->>'due_at')::timestamptz,
        milestone_status, -- text 类型
        COALESCE((milestone_item->>'is_critical')::boolean, false),
        COALESCE((milestone_item->>'evidence_required')::boolean, false),
        NULLIF(milestone_item->>'notes', 'null')
      )
      ON CONFLICT (order_id, step_key) DO NOTHING;
    END IF;
  END LOOP;

  -- 4. 记录系统日志（可选）
  -- 可以在这里记录初始化日志到 order_logs
END;
$$;

-- 添加函数注释
COMMENT ON FUNCTION public.init_order_milestones(uuid, jsonb) IS 
'系统级函数：初始化订单里程碑。使用 SECURITY DEFINER 绕过 RLS，仅用于系统初始化。';

-- 授予执行权限（仅限认证用户）
GRANT EXECUTE ON FUNCTION public.init_order_milestones(uuid, jsonb) TO authenticated;
