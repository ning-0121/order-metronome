'use client';

/** 生产跟单表:先预览再下载。 */

import { ExportPreviewButton } from '@/components/ExportPreviewButton';
import { exportProductionTrackingSheet } from '@/app/actions/export-production-sheet';

export function ExportProductionSheetButton() {
  return (
    <ExportPreviewButton
      label="📥 导出生产跟单表"
      className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 disabled:opacity-50 transition-all"
      fetcher={exportProductionTrackingSheet}
    />
  );
}
