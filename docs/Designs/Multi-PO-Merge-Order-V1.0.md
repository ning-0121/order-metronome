# 多客户PO合并为一个内部订单 设计方案 V1.0

> 2026-07-11,用户口述需求整理。状态:**P1 代码已实现,待迁移执行 + 实测**(build✅/check✅/改动区零新增tsc错)。
> 原则:**合单发生在建单阶段**,把多张客户PO的明细都灌进同一个 order 的 `order_line_items`,逐行带来源PO溯源;下游(生产单/采购MRP/财务/出货)复用现有链路,纯加法,零回归。

## 一、业务背景

客户一次需求下来,常裂分成多张 PO(客户侧的账务/信用证/分单习惯),但因**交期一致**,绮陌合并为**一个内部订单号**统一生产。当前系统是「一单绑一个PO」的 1:1 模型,无法承接。

**需求一句话**:多个 PO 上传 → 合并成一个内部订单 → 生成一张生产单,且每款每色可回溯到它来自哪张客户PO。

## 二、双门禁准入

### 🏛 Architecture Gate
- **属哪个 Domain**:Order 域(需求表达)。不碰 Production 实现域。
- **数据所有权**:客户PO原文/PO号/PO金额归 `order_customer_pos`(新);款色码明细仍归 `order_line_items`(唯一真相,不复制)。
- **有无重复真相**:无。生产单/PI/采购/财务全部**派生读取** `order_line_items`,不另存明细。`order_customer_pos` 只存PO级元数据(号/文件/快照/金额),不存款色明细。

### 🔮 Future Gate
- **3年后/10工厂还成立吗**:成立。多PO合单是行业常态(信用证分单、客户ERP分单)。模型用「订单 ←< 来源PO ←< 明细」三层,与已冻结的 [ADR-003 Order/Production 解耦]、[ADR-002 物料需求脊柱] 一致,可长期演进。
- **拒绝的过度设计**:不把 `orders.po_number` 升级成数组(会打穿一堆 `.map(String)` 消费点);不为多PO造并行建单/生产链路。

## 三、用户拍板口径(2026-07-11)

① **生产单按PO批次拆**:同款同色来自两张PO → `order_line_items` 保持两行,永不跨PO自动合并求和。生产单按 `款×色×来源PO` 呈现,车间按PO分批投产。
② **财务按内部订单号做账**:多张PO金额**归集到内部订单号下汇总**,不按PO拆应收/拆PI。`order_customer_pos.po_amount` 仅作信息留存/存档,财务链零改动(继续按 `internal_order_no` 汇总)。

## 四、数据模型(纯加法)

```
orders (1) ───< order_customer_pos (N)         新表:一张客户PO一行
   │                · order_id (FK→orders, ON DELETE CASCADE)
   │                · customer_po_number  text
   │                · seq                 int   (PO批次序 1/2/3…)
   │                · attachment_id       uuid  (原始PO文件存档,可空)
   │                · po_parse_snapshot   jsonb (AI原文冻结,可空)
   │                · po_amount           numeric (可空,仅信息,财务不按它拆)
   │                · created_at / created_by
   │                UNIQUE(order_id, customer_po_number)
   │
   └───< order_line_items
            + source_order_po_id  uuid FK→order_customer_pos (可空)
                                        每行挂到它来自的那张PO;老单为空,向后兼容
```

- **`orders.po_number` 不动**,做主显示(存首张,或逗号拼接多张PO号)。`customer_po_id` 单FK保留兼容,新流程不强依赖。
- **`order_line_items` 只加一列** `source_order_po_id`,nullable,老数据/单PO单为空——完全向后兼容。
- FK 需在 DB 显式声明,让 PostgREST 能做嵌套 join(`.select('*, order_customer_pos(...)')`),否则报 `Could not find a relationship`(见 CLAUDE.md 调试铁律)。

## 五、流程

### 1. 多PO建单入口(新)
现有解析入口均单文件(`po-parser` 单 buffer / `po-extract` 单 attachmentId)。新增「多PO建单」入口:上传 N 个文件 → 循环逐张解析。
- Excel 走 `lib/services/excel-read.ts` 统一读(规避老 `.xls` BIFF 被读空的坑)。
- 图片/PDF 走 `po-parser` AI Vision。
- 每张解析产物暂存,标注来源文件名。

### 2. 合并复核台(「系统计算·人决策」落点)
N 张 PO 解析结果并排铺进复核屏,**复用 `LineItemMatrixEditor`**:
- 每行带「来源PO」标签/下拉(默认=它解析自的那张文件)。
- 人可增删改、纠正识别错误、调整来源PO归属。
- **不做跨PO合并**——保持逐行独立(正是加单功能 insert-only 范式)。

### 3. 一次 createOrder
- 生成一个系统单号(`QM-YYYYMMDD-XXX`)+ 一个内部订单号(查重)。
- 写 N 行 `order_customer_pos`(seq 递增)。
- `order_line_items` 逐行 insert,带 `source_order_po_id` + `source='po_parse'`。
- `orders.po_number` = 多PO号拼接;`quantity` = Σ 全行件数。

### 4. 下游自动继承
| 下游 | 是否改动 | 说明 |
|---|---|---|
| 采购MRP归并 | 不改 | 按物料跨行汇总,一PO一行不影响归并 |
| 库存/收货 | 不改 | 按内部订单号 |
| 财务应收/PI | 不改 | 口径②:按 `internal_order_no` 汇总 |
| 出货单据(PL/CI/报关) | 不改 | 按内部订单号;CI 可选带多PO号 |
| **生产单(MO)** | **改一处** | 见六 |

## 六、生产单改动(唯一需动的下游)

`app/actions/manufacturing-order.ts` `getManufacturingOrder` 现按 `style_no+color` 分组。按口径①改为**按 `style_no + color + source_order_po_id` 分组**(或逐行渲染 + 加「来源PO」列),让同款同色的两张PO批次显示成两行。
- Excel 生产单(`generate-production-order.ts`)对应加一列 PO 批次号。
- MO 仍 `order_id` 1:1,不改绑定关系。

## 七、实施分期

- **P1**(本方案核心):建表 + 明细加列 + 多PO建单入口 + 合并复核台 + createOrder 写多PO + 生产单批次列。目标=多PO合单端到端跑通,溯源可查。
- **P2**(可选增强):`order_customer_pos.po_amount` 录入(建单时逐PO填金额,给财务留存);出货单据 CI 带全部PO号。
- **P3**(未来):按来源PO做局部操作(如某张PO单独取消/改期)——当前不做,留接口。

## 八、迁移清单

| # | 迁移文件 | 内容 | 门禁 |
|---|---|---|---|
| 1 | `2026xxxx_order_customer_pos.sql` | 建 `order_customer_pos` 表 + RLS + FK→orders | 建表后逐条验证列/约束真实存在 |
| 2 | `2026xxxx_oli_source_po.sql` | `order_line_items` 加 `source_order_po_id` + FK | 验证列 + FK 声明成功(PostgREST 能 join) |

- 迁移执行后按 [数据库门禁] 逐条验证 SQL 真返回 → PASS 才可写码/build/commit/push。
- 每个执行过的迁移单独 commit 归档进 git(见 [Migration 归档纪律])。

## 九、DoD 硬闸

- [ ] 迁移门禁 PASS(2 个迁移逐条验证)
- [ ] `npm run build && npm run check` 全过(pre-deploy-check 断言不破)
- [ ] 权限:多PO建单入口有 auth + 角色检查;`po_unit_price`/`po_amount` 不泄露给 production/merchandiser/admin_assistant
- [ ] 单PO建单老路径不受影响(`source_order_po_id` 为空正常渲染)
- [ ] 生产单批次拆分正确;采购MRP/财务应收按内部订单号汇总不变
- [ ] 用户 diff 审查通过

## 十、回滚

- 建表/加列均为纯加法,无害保留即可。
- 前端多PO入口可 feature flag 控制(单PO老入口始终保留)。

## 十一、P1 已落地改动清单(2026-07-11)

| 文件 | 改动 |
|---|---|
| `supabase/migrations/20260711_order_customer_pos.sql` | 新表 + RLS + 验证SQL(**待执行**) |
| `supabase/migrations/20260711_oli_source_po.sql` | order_line_items 加 source_order_po_id(**待执行**) |
| `app/actions/orders.ts` createOrder | 读 `customer_pos` formData → 写 order_customer_pos → 按款 `source_po_number` 回填每行 `source_order_po_id`;优雅降级(表/列缺失不阻断) |
| `app/actions/manufacturing-order.ts` | getManufacturingOrder 返回 customerPos(仅 id/号/seq,**不含金额**);buildMoWorkbook 按 色×source_order_po_id 拆(multiPO≥2 才拆),色行冠 `PO1/PO2` 批次标签 |
| `components/order/LegacyOrderForm.tsx` | 多文件解析每款打 `source_po_number`(不跨PO去重);≥2张不同PO → customerPos state + 提交带 `customer_pos`;PO号框下「多PO合单」提示条 |
| `components/order/LineItemMatrixEditor.tsx` | Style 加 source_po_number;款块头只读徽标「📄 PO xxx」;copyStyle 保留溯源 |

**已知边界**:`app/actions/generate-production-order.ts`(POParserModal 里「解析某PO直接导Excel」独立工具)不读 order_line_items、无PO溯源,保持不动。规范生产单走 buildMoWorkbook。

**实测步骤**(迁移 PASS 后):建单页上传 2 张不同PO号文件 → 见「多PO合单」提示 + 明细每款带 PO 徽标 → 建单 → 查 order_customer_pos 有2行、order_line_items.source_order_po_id 已回填 → 生成生产单 Excel 见同款同色按 PO1/PO2 拆两行。单PO上传:无提示条、source_order_po_id 为空、生产单按款×色合并(不回归)。

## 附:关键文件锚点

| 类型 | 路径 |
|---|---|
| PO解析(AI) | `app/actions/po-parser.ts` |
| PO解析(Excel零token) | `lib/services/order-sheet-parser.ts` + `lib/services/excel-read.ts` |
| 建单主链 | `app/actions/orders.ts` `createOrder` |
| 明细录入组件 | `LineItemMatrixEditor`(复用) |
| 生产单读取层 | `app/actions/manufacturing-order.ts` `getManufacturingOrder` |
| Excel生产单 | `app/actions/generate-production-order.ts` |
| 加单范式参照 | `app/actions/order-amendments.ts` `applyCustomerAddOrder` |
