'use client';

import { AIAdviceBox } from '@/components/AIAdviceBox';

export function DashboardAIAdvice({ contextData }: { contextData: string }) {
  if (!contextData) return null;
  return (
    <div className="mb-6">
      <AIAdviceBox scene="dashboard" contextData={contextData} />
    </div>
  );
}
