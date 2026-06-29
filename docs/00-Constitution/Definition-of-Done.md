# QIMO OS Definition of Done（DoD,交付标准)

> **Status**: Active　**Date**: 2026-06-29　所有开发**必须**满足本标准才算"完成"。
> 是开发流程最后一段:`… → Design → Coding → DoD`。任何一项不满足 = 未完成,**禁止 push**。

---

## 1. 设计阶段 DoD
- [ ] 业务**闭环**画清(本步在 Domain 闭环里的位置)。
- [ ] **对象归属**明确:新增/修改的是哪个业务对象,谁拥有它。
- [ ] **字段归属**不混(业务/系统/采购/采购执行/仓库 各管各的,不跨职责)。
- [ ] **引用不复制**:需求/真相只引用上游,不复制数字。
- [ ] **面向十年自检**(DP-4):10 工厂 / 1000 员工 / 100 亿,这设计还成立?锚稳定身份、留扩展位。
- [ ] migration 草案齐全:**RLS / FK(含删除规则)/ indexes / verification SQL / rollback**;纯加法、幂等、可回滚。
- [ ] 设计文档落 `docs/Designs/`;重要决策落 `docs/ADR/`。

## 1.5 对象准入双门禁（新增任何 Business Object / 表之前必须通过)
> 很多 ERP 死在乱建对象。新增对象前,这两道门必须答清,否则不许开工。

**🏛 Architecture Gate（架构门)**
- [ ] 它属于**哪个 Domain**?
- [ ] 它的**数据所有权**是谁(业务/系统/采购/采购执行/仓库/…)?
- [ ] 有没有**重复真相**(别的对象已经拥有这份数据)?能不能改为**引用**而非新建?

**🔮 Future Gate（未来门,DP-6)**
- [ ] **三年以后 / 5 家工厂 / 10 家工厂**,这个对象还能不能用?
- [ ] 锚的是**稳定身份**还是易失 id?有没有留扩展位(跨订单/多 UoM/多工厂)?
- [ ] 答案否定 → **不能通过,重新设计**。

## 2. 编码阶段 DoD
- [ ] **围绕业务对象**编码,不为页面写死真相。
- [ ] **系统算 / 人决策**:机械劳动(汇总/归并/取整/推荐)系统做,关键数据人工确认;**不接 AI 直接写库**。
- [ ] **边界锁定**:明确列出"不改"清单(线上在用的 O1/O2/B1/material_requirements/procurement_line_items/采购中心…),并守住。
- [ ] **纯加法、兼容、渐进、可回滚**,不影响线上正在运行的功能。
- [ ] 上游表只读引用,不改其计算/结构。
- [ ] `npm run build` ✅ 且 `npm run check` ✅(pre-deploy + runtime + 各服务单测全过)。

## 3. 数据库 DoD（migration 专用,门禁)
- [ ] migration 草案 → 用户审 → **用户手动执行**(Claude 不执行)。
- [ ] **数据库门禁逐条验证**(① 表 ② 字段 ③ FK 删除规则 ④ UNIQUE ⑤ Index ⑥ RLS ⑦ 行数 ⑧ CHECK),**真实返回结果**,一条一条判,出 **PASS/FAIL** 报告。
- [ ] **只有 PASS** 才能写代码/build/commit/push;FAIL 必须指出哪项/影响/如何修。
- [ ] 执行过的 migration **单独 commit 归档**进 git(`chore: archive … migration`),保证 clone 可重建 DB。

## 4. 交付阶段 DoD
- [ ] **diff 给用户审**,用户批准后才 push(diff-before-push)。
- [ ] push 前:`git fetch` + 查分叉(远程未领先);只暂存**授权文件**(`git diff --cached --name-only` 核对)。
- [ ] commit 信息规范(`feat/fix/docs/chore: …`);doc 与功能代码、migration **分开 commit**。
- [ ] push 后:线上可达验证(无 500)、`HEAD == origin/main`、git status 干净。
- [ ] 记忆/文档同步更新(`docs/` + auto-memory)。
- [ ] 回滚路径明确(`git revert <sha>` / env flag / DROP TABLE)。

---

## 🚦 硬闸
**开工前(新增对象)**:未过 §1.5 **Architecture Gate + Future Gate** = 禁止建对象/建表。
**push 前(任一不满足 = 禁止 push)**:
1. **数据库门禁未 PASS**(涉及 migration 时)。
2. `build` 或 `check` 未过。
3. **未经用户 diff 审查**。
4. 改了"不改清单"里的东西 / 影响了线上。

> DoD 不是束缚,是让"完成"客观可验证。本文件 §1.5(对象准入双门禁)+ §3(数据库门禁)+ §4(归档/diff)把"架构门/未来门/数据库验证门禁/migration 归档/diff-before-push"全部固化为交付标准;配合 Development Principles DP-1~8。
