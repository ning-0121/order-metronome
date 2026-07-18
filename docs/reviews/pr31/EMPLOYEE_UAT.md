# PR #31 Employee UAT Checklist

UAT mode: C — NO SAFE WRITE UAT

Reason:

- Preview and Production use the same Supabase project, auth, and storage identity.
- Any authenticated write test from Preview can affect live Production data.
- No separately approved test order or isolated test tenant is available in the current release context.

## Checklist

1. 测试环境和测试订单：当前不可执行写入型员工 UAT；仅允许只读核对
2. 测试账号角色：只读验证可用的员工账号；不执行保存
3. 测试前原值：如需后续 UAT，先在独立测试环境记录原值
4. 保存正常正数：当前被阻止，因会写入生产后端
5. 刷新后确认仍存在：当前被阻止，因会写入生产后端
6. 删除/清空后的 null 行为，如业务允许：当前被阻止，因会写入生产后端
7. 报价基准仅显示为“建议”：可在只读预览中确认
8. 保存 0 的行为，如业务允许：当前被阻止，因会写入生产后端
9. 失败时明确报错：可在只读代码审计与自动化测试中确认
10. 生产任务单下载：可在 Preview 中进行只读检查
11. 技术确认单上传反馈：当前被阻止，因会写入生产后端
12. 测试后恢复原值或清理数据：当前不执行任何写入型 UAT
13. 截图/录屏证据要求：仅保留只读页面截图与构建日志
14. UAT 通过人姓名和时间：待独立测试环境就绪后再填写

## 当前允许的安全验证

- 只读打开 Preview 页面
- 检查下载按钮是否触发浏览器下载
- 检查预算单价页面是否区分“已保存预算”和“报价基线建议”
- 检查未登录/未授权状态是否保持原有服务器保护

## 需要的最小安全前置条件

1. 独立 Preview Supabase 项目/数据库/Storage
2. 或者明确批准的非业务测试订单
3. 或者单独的只读验收环境

在以上条件满足前，不安排员工执行写入型 UAT。
