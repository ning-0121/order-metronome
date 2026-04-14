'use client';

import { useState } from 'react';

interface ExpandableListProps {
  children: React.ReactNode[];
  initialCount?: number;
  expandLabel?: string;
  collapseLabel?: string;
}

export function ExpandableList({
  children,
  initialCount = 5,
  expandLabel,
  collapseLabel = '收起',
}: ExpandableListProps) {
  const [expanded, setExpanded] = useState(false);
  const total = children.length;

  if (total <= initialCount) {
    return <>{children}</>;
  }

  const visibleItems = expanded ? children : children.slice(0, initialCount);
  const hiddenCount = total - initialCount;

  return (
    <>
      {visibleItems}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full py-3 text-sm font-medium text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 rounded-xl border border-dashed border-indigo-200 transition-colors"
      >
        {expanded
          ? collapseLabel
          : expandLabel || `展开全部（还有 ${hiddenCount} 条）`}
      </button>
    </>
  );
}
