# QIMO 角色交接矩阵

| Stage | From Role | To Role | Trigger | Data Required | Ownership Added | Ownership Retained | Approval | Next Action | Audit Evidence |
|---|---|---|---|---|---|---|---|---|---|
| 商务确认 | 业务开发 | 业务执行 | PO、价格、条款、客户交期确认 | PO、报价、付款条款、关键产品信息 | business_execution_owner | development_owner（客户商业变更） | 特殊价格/条款由开发经理/Finance | AI 识别、人工核对、建单 | handoff actor/time、附件、确认值 |
| 生产需求 | 业务执行 | 生产主管 | 订单资料与生产要求 ready | Order Master、BOM、交期、包装、风险 | production_manager_owner | business_execution_owner | 生产主管接收 | 匹配工厂和排产 | 提交人、接收人、时间 |
| 定厂排产 | 生产主管 | 生产跟单/QC | 工厂及排期最终确认 | 工厂、planned dates、数量、风险 | production_follow_up_owner | business_execution_owner + production_manager_owner | 生产主管 | 工厂沟通、物料、开裁 | decision actor/time/reason、排产版本 |
| 采购执行 | 业务执行/BOM | 采购 | approved requirement | BOM、数量基准、需到日 | procurement_owner | business_execution_owner | 采购让步由采购经理 | 询价/下单/催货 | source BOM、approver、PO |
| QC/整改 | 生产跟单/QC | 生产主管 + 业务执行 | 检验失败/重大缺陷 | 报告、照片、缺陷、整改 | 不替换 owner | execution + PM + follow-up | QC release；重大影响按角色升级 | 整改/复检/客户协调 | 报告、actor/time、结论 |
| 出货准备 | 业务执行 + 跟单/QC | 物流 | 包装完成且进入出货 gate | QC release、客户确认、财务条件、箱单 | logistics_owner | execution + follow-up | 组合 gate | 订舱、出库、跟踪 | gate 结果、物流凭证 |
| 关闭 | 物流/Finance/跟单 | 业务执行 | 最终出货和商业关闭条件完成 | shipment、收款/结算状态、异常关闭 | 无 | business_execution_owner 至关闭 | 执行经理按例外政策 | 关闭订单 | close actor/time/reason |
