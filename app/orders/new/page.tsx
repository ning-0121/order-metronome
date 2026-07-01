'use client';

/**
 * /orders/new —— Order Intake dual-mode 入口（PO-first + legacy 回退）。
 *
 * 无业务逻辑：仅渲染模式选择器。
 * legacy 手工/OCR 表单逻辑 **逐字保留** 于 components/order/LegacyOrderForm.tsx，
 * 由 OrderIntakeModeSelector 条件渲染。createOrder / kernel / router / PO 逻辑均未改。
 */

import { OrderIntakeModeSelector } from '@/components/order/OrderIntakeModeSelector';

export default function NewOrderPage() {
  return <OrderIntakeModeSelector />;
}
