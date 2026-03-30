'use client';

import { useState } from 'react';

const TABS = [
  { key: 'overview', label: '概览' },
  { key: 'issues', label: '问题中心' },
  { key: 'actions', label: '行动建议' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

interface AdminTabNavProps {
  overviewContent: React.ReactNode;
  issuesContent: React.ReactNode;
  actionsContent: React.ReactNode;
}

export function AdminTabNav({ overviewContent, issuesContent, actionsContent }: AdminTabNavProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('overview');

  const contentMap: Record<TabKey, React.ReactNode> = {
    overview: overviewContent,
    issues: issuesContent,
    actions: actionsContent,
  };

  return (
    <div>
      {/* Tab bar */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1 mb-6">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
              activeTab === tab.key
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {contentMap[activeTab]}
    </div>
  );
}
