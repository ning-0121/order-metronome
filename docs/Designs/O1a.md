# O1a 设计:Material Master 建库 + 种子沉淀 + 管理页

> 状态:**设计待审**。不写代码 / 不执行 SQL / 不 push / 不改采购流 / 不影响 B1 / 不做 AI。
> 配套:`supabase/migrations/DRAFT_20260628_o1a_material_master.sql`(migration 草案)。

---

## 1. material_master migration 草案
见 DRAFT 文件。要点:公司级主数据,含 `is_temporary`(临时物料)+ `source_order_id` + `promoted_at/by` + `seed_source` + `usage_count`;`material_code` 唯一(可空,临时无码);索引 (lower(name),category) 供搜索/去重。RLS 登录可读/可建,改正式+转正在 action 按角色把关。纯加法、幂等、回滚干净。

## 2. materials_bom 需新增的列
| 列 | 说明 |
|---|---|
| `material_master_id` uuid FK→material_master (ON DELETE SET NULL) | Package 行引用主数据(临时物料也在 master,故也指它)|
| `special_requirements` text | 本单该物料的特殊要求 |
> 不动现有列;B0/B1 读 materials_bom 不变。`category` 列留 O1b(衔接 B1 时加)。

## 3. 种子 dry-run SQL / 脚本设计(先预览,不导入)
**执行 migration 后,先跑下面 dry-run SELECT 预览候选,人工审过,再跑 execute INSERT。**
**原则:宁可少不要脏。** 质量过滤:辅料丢空名/单字符/占位名;面料必须有成分或类型(否则组合名无意义)。

```sql
-- ── DRY-RUN A:辅料/包材候选(来自 customer_trim_library,名称+类别去重)──
SELECT * FROM (
  SELECT DISTINCT ON (lower(material_name), cat) material_name, cat AS category,
         spec AS specification, supplier AS default_supplier_name,
         qty_per_piece AS default_consumption, unit AS default_unit, 'trim_library' AS seed_source
  FROM (
    SELECT material_name, spec, supplier, qty_per_piece, unit, updated_at,
      CASE material_type WHEN 'fabric' THEN 'fabric' WHEN 'lining' THEN 'fabric'
           WHEN 'trim' THEN 'trim' WHEN 'label' THEN 'trim' WHEN 'packing' THEN 'packing'
           ELSE 'other' END AS cat
    FROM customer_trim_library WHERE active = true
  ) t ORDER BY lower(material_name), cat, updated_at DESC
) x ORDER BY category, material_name;

-- ── DRY-RUN B:面料候选(来自 quoter_fabric_records,组合名,按组合键去重)──
SELECT * FROM (
  SELECT DISTINCT ON (lower(coalesce(fabric_type,'')||coalesce(fabric_composition,'')||coalesce(fabric_weight_gsm::text,'')))
    trim(coalesce(fabric_type,'面料')||' '||coalesce(fabric_composition,'')||
         CASE WHEN fabric_weight_gsm IS NOT NULL THEN ' '||fabric_weight_gsm||'gsm' ELSE '' END) AS material_name,
    'fabric' AS category,
    trim(coalesce(fabric_composition,'')||
         CASE WHEN fabric_width_cm IS NOT NULL THEN ' 幅宽'||fabric_width_cm||'cm' ELSE '' END||
         CASE WHEN fabric_weight_gsm IS NOT NULL THEN ' '||fabric_weight_gsm||'gsm' ELSE '' END) AS specification,
    factory_name AS default_supplier_name, consumption_kg AS default_consumption, 'kg' AS default_unit,
    'fabric_records' AS seed_source
  FROM quoter_fabric_records
) y ORDER BY material_name;

-- ── DRY-RUN C:统计(候选总数 / 各来源 / 各类别)──
SELECT 'trim_library' AS src, count(*) FROM (上面 A 的子查询去重后) ...   -- 实现时复用 A
UNION ALL SELECT 'fabric_records', count(*) FROM (上面 B) ...;
```
> execute(审过后)= 把上面 A、B 的 `SELECT` 改成 `INSERT INTO material_master(material_name, category, specification, default_supplier_name, default_consumption, default_unit, seed_source) SELECT ...`,并在末尾 `WHERE NOT EXISTS(SELECT 1 FROM material_master m WHERE lower(m.material_name)=lower(候选.material_name) AND m.category=候选.category)` 防重入。**execute 由人审过 dry-run 后再跑。**

> 面料组合名可能不优雅(如"单面 95%棉5%氨纶 180gsm")→ 管理页支持改名(§管理页)。

## 4. 去重规则
- **硬约束**:`material_code` UNIQUE(非空时)。
- **种子去重**:每源内 `DISTINCT ON (lower(name), category)`;execute 时 `NOT EXISTS` 防重入;辅料(非 fabric)与面料(fabric)类别天然少重叠。
- **录入新建防重复(控制点 B)**:业务新建物料时,系统查 `is_temporary=false AND category=X AND material_name 相似(ILIKE 关键词;若装 pg_trgm 用 similarity)` → 命中则提示**"可能已有类似物料:XXX"**,但 **V1 不强制阻止**,业务可坚持新建。

## 5. temporary material 设计(控制点 A)
- **本质**:临时物料 = `material_master` 里 `is_temporary=true` + `source_order_id=本订单` 的行(无 `material_code` 或临时码)。Package 行照常用 `material_master_id` 指它。
- **可见性**:正式主数据搜索**只显示 is_temporary=false**;临时物料**只在其来源订单**可见(+ 管理员"待转正"清单可见全部)。→ 满足"暂不沉淀为公司主数据"。
- **创建**:业务在 Package 里"新建物料"时,可选"暂存为临时物料"(只服务本单)或"加入公司主数据"。
- **转正(Helen/admin)**:在"待转正"清单里选临时物料 → 查重(§4)→ 赋码 → `is_temporary=false, promoted_at/by=now/操作人`。从此全公司可复用。
- **不删 Package 引用**:转正只翻标志,materials_bom.material_master_id 不变。

## 6. RLS / 权限
- **RLS(migration 里)**:SELECT/INSERT/UPDATE 均"登录即可"(material_master)。
- **角色把关(server action 里,不靠 RLS)**:
  - 搜索/选用:所有登录用户。
  - 新建(含临时):业务/理单/管理员。
  - **编辑已有正式主数据 / 归档 / 转正**:仅理单/管理员(防改坏共享数据)。
- materials_bom 新列:沿用现有 materials_bom RLS。

## 7. 回滚方案
纯加法。回滚:`materials_bom DROP COLUMN material_master_id, special_requirements;` + `DROP TABLE material_master;`。种子数据随表删除;若只想清种子:`DELETE FROM material_master WHERE seed_source IN ('trim_library','fabric_records');`。

## 8. 验收标准
1. `material_master` 表 + materials_bom 两新列建好(验证 SQL 通过)。
2. **dry-run** 先出候选 + 统计,数量合理、无明显重复;**人工审过才 execute**。
3. execute 后 master 有数据;`seed_source` 标对。
4. **Material Master 管理页**:列表 / 搜索(名/码/类别)/ 新建 / 编辑(受控)/ 归档 / "待转正"清单 + 转正。
5. 临时物料:能在订单内创建、只本单可见、管理员能转正后全局可复用。
6. 新建时**相似物料提示**生效(不阻断)。
7. 现有 采购中心 / ProcurementTab / B0 / B1 **零影响**;materials_bom 现有读写不变。
8. build + check 通过;不 push 直到你批。

## 9. 风险清单
| 风险 | 级别 | 缓解 |
|---|---|---|
| 种子质量差(脏数据/丑名)| 中 | dry-run 先审 + 管理页可改名/归档 |
| 去重漏(同物料多条)/ 误并(不同物料合一)| 中 | 名称+类别去重 + 录入相似提示;管理页可合并/归档(合并留后续)|
| 临时物料泛滥不转正 | 中 | "待转正"清单 + usage_count 提示高频临时物料该转正 |
| 谁维护主数据(脏改)| 中 | 编辑正式/转正受控(理单/管理员)|
| 面料组合名不规范 | 低 | 管理页改名;源是参考不是权威 |
| pg_trgm 未装(相似度)| 低 | 回退 ILIKE 关键词匹配,V1 够用 |
| B1 受影响 | 无 | 只加列、materials_bom 读写不变、master 与 B1 无耦合 |

## Roadmap(O1a 内部)
- **O1a-1**:执行 migration(你审 DRAFT → 定稿 → 你执行)。
- **O1a-2**:跑 dry-run 预览种子 → 你审 → execute 导入。
- **O1a-3**:Material Master 管理页(列表/搜索/新建/编辑/归档/待转正/转正)+ 相似提示。
- 之后 → O1b(订单 Material Package 录入,选物料/带入/复制上一单/填单耗)。
