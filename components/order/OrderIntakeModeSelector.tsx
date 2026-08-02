'use client';

/**
 * 建单入口(2026-08-01 全面审计后简化为单一路径)。
 *
 * 这里原本是个「PO 驱动 / 手工录入」双模式切换器,顶部还写着
 * 「本订单系统以 PO 驱动为主路径(订单从已审批报价快照派生)。手工录入为 legacy 回退模式」——
 * **说反了**。生产数据:
 *   PO 驱动链(报价器 → 客户PO → 从PO建单)  quoter_quotes 0 / customer_po 0 → 一张单都没建过
 *   所谓「legacy 回退」的手工录入                orders 202 张,全部订单都走它
 * 按钮上甚至就写着「从 PO 创建(暂无 PO)」—— 一个永远没有数据的模式,还被标成主路径。
 *
 * CEO 2026-08-01 拍板报价器不留 → PO 驱动链的源头没了(`?po=` 只有客户PO页会传),
 * 该模式永久不可达。于是不再"留个切换器让人纠结选哪个",直接进唯一在用的表单。
 *
 * araos 一键建单是另一条独立路径(/orders/from-araos,自带表单直连 createOrder),不受影响。
 *
 * 本组件保留(而非让页面直接渲染 LegacyOrderForm):它承载了套装数量口径的提醒,
 * 那条提醒救过命 —— 选错单位会少备一半料。
 */

import { LegacyOrderForm } from './LegacyOrderForm';

export function OrderIntakeModeSelector({ showPrice }: { showPrice: boolean }) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        📦 <b>套装提醒</b>:客户按「套」下单的(如 1 套 = 2 件),数量务必<b>按总件数</b>录,
        或把单位选「<b>套(2件)</b>」。系统一律按<b>件数</b>驱动采购/生产/装箱,
        <b>选错会少备一半料</b>。
      </div>
      <LegacyOrderForm showPrice={showPrice} />
    </div>
  );
}
