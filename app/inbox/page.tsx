import { InboxClient } from '@/components/InboxClient';

export const dynamic = 'force-dynamic';

export default function InboxPage() {
  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <InboxClient />
    </div>
  );
}
