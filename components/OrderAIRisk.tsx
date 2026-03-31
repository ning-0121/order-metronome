'use client';

import { AIAdviceBox } from '@/components/AIAdviceBox';

export function OrderAIRisk({ contextData, orderId }: { contextData: string; orderId: string }) {
  if (!contextData) return null;
  return <AIAdviceBox scene="order_detail" orderId={orderId} contextData={contextData} />;
}
