# Order Metronome (V1) - Setup Guide

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Up Supabase

1. Create a new Supabase project at https://supabase.com
2. Go to SQL Editor
3. Copy and paste the entire contents of `supabase/migration.sql`
4. Run the SQL migration

### 3. Configure Environment Variables

Create `.env.local` in the root directory:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
NEXT_PUBLIC_SITE_URL=http://localhost:3000

# SMTP Configuration (Tencent enterprise mail)
SMTP_HOST=smtp.exmail.qq.com
SMTP_PORT=465
SMTP_USER=noreply@qimoclothing.com
SMTP_PASSWORD=your-smtp-password
SMTP_FROM=noreply@qimoclothing.com
```

### 4. Run Development Server

```bash
npm run dev
```

Visit http://localhost:3000

## Features Implemented

### ✅ Authentication
- Email/password authentication
- Domain restriction (@qimoclothing.com only)
- Signup/login pages
- Protected routes via middleware

### ✅ Orders Management
- Create orders with FOB/DDP incoterms
- ETD required for FOB, Warehouse Due Date for DDP
- Order types: sample/bulk
- Packaging types: standard/custom
- Orders list and detail pages

### ✅ Automated Milestones
- Auto-generated milestone templates on order creation
- Milestone fields: step_key, name, owner_role, owner_user_id, planned_at, due_at, status, is_critical, evidence_required, watchers
- Backward scheduling from ETD/Warehouse Due Date

### ✅ Time Decomposition Engine
- Backward scheduling from target dates
- Business day handling (excludes weekends)
- Internal controls:
  - PO+2 workdays: procurement sheet + finance approval
  - PO+3 workdays: order sheet + production sheet + packaging spec
- Packaging materials: production_offline - 7 days (or packaging_due - 7 days for custom)
- Custom packaging adds 7 additional days

### ✅ Status Machine
- **Done**: Automatically advances next milestone
- **Blocked**: Requires reason + note
- **Overdue**: Automatically detected
- **In Progress**: Active milestone
- **Pending**: Waiting to start

### ✅ Delay Management
- Delay request system
- Approval workflow (owner or admin)
- Automatic downstream milestone recalculation on approval
- Delay request history

### ✅ Notifications
- Email notifications via SMTP (Tencent enterprise mail)
- In-app notifications
- Reminders at 48/24/12 hours before due
- Escalation to su@qimoclothing.com and alex@qimoclothing.com for overdue/blocked

### ✅ Pages
- **My Beats** (`/dashboard`): User dashboard with assigned milestones
- **Orders List** (`/orders`): All orders with filtering
- **Order Detail** (`/orders/[id]`): Timeline, logs, milestone actions, delay requests
- **Admin Dashboard** (`/admin`): Risk/overdue list, bottleneck analysis by role

## Database Schema

The migration includes:
- `profiles` - User profiles with roles
- `orders` - Orders table
- `milestones` - Milestone tracking
- `milestone_logs` - Audit trail
- `delay_requests` - Delay management
- `notifications` - In-app notifications
- `order_attachments` - File attachments (structure ready)

## Key Files

- `supabase/migration.sql` - Database schema
- `lib/utils/time-decomposition.ts` - Milestone scheduling engine
- `lib/utils/notifications.ts` - Email and notification system
- `app/actions/` - Server actions for orders, milestones, delays, auth
- `middleware.ts` - Route protection and domain validation

## Next Steps

1. Set up SMTP credentials for email notifications
2. Configure Supabase RLS policies if needed
3. Test the milestone scheduling logic with real orders
4. Set up file storage for order attachments (Supabase Storage)
5. Deploy to production (Vercel recommended)

## Notes

- Email notifications require SMTP configuration
- Milestone owners are initially null and can be assigned by admins
- All dates use business days (weekends excluded)
- The system automatically detects overdue milestones
- Delay requests require approval before recalculating downstream milestones
