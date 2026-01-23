# Order Metronome (V1)

A comprehensive Next.js + Supabase web application for tracking and managing orders with automated milestone management, delay handling, and notifications.

## Features

- **Authentication**: Email/password authentication with @qimoclothing.com domain restriction
- **Orders Management**: Create and manage orders with FOB/DDP incoterms, ETD/Warehouse Due Date tracking
- **Automated Milestones**: Auto-generated milestone templates based on order type with backward scheduling
- **Time Decomposition Engine**: Intelligent backward scheduling from ETD or Warehouse Due Date with business day handling
- **Status Machine**: Milestone status management (Done → next, Blocked, Overdue detection)
- **Delay Management**: Delay request system with approval workflow and automatic downstream recalculation
- **Notifications**: Email notifications via SMTP (Tencent enterprise mail) + in-app notifications with reminders and escalation
- **Dashboard**: My Beats page for user-specific milestones, Orders list, Order detail with timeline/logs, Admin dashboard with risk analysis

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **Database**: Supabase (PostgreSQL)
- **Authentication**: Supabase Auth
- **Email**: Nodemailer with SMTP (Tencent enterprise mail)

## Getting Started

### 1. Prerequisites

- Node.js 18+ and npm
- Supabase account and project
- SMTP credentials (Tencent enterprise mail)

### 2. Installation

```bash
npm install
```

### 3. Environment Variables

Create a `.env.local` file in the root directory:

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
NEXT_PUBLIC_SITE_URL=http://localhost:3000

# SMTP Configuration (Tencent enterprise mail)
SMTP_HOST=smtp.exmail.qq.com
SMTP_PORT=465
SMTP_USER=your_smtp_user@qimoclothing.com
SMTP_PASSWORD=your_smtp_password
SMTP_FROM=noreply@qimoclothing.com
```

### 4. Database Setup

Run the migration SQL in your Supabase SQL Editor:

```bash
# The migration file is located at:
supabase/migration.sql
```

Copy the contents of `supabase/migration.sql` and run it in the Supabase SQL Editor.

### 5. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Project Structure

```
order-metronome/
├── app/
│   ├── actions/           # Server actions (orders, milestones, delays, auth)
│   ├── admin/             # Admin dashboard
│   ├── dashboard/         # My Beats (user dashboard)
│   ├── login/             # Login/signup page
│   ├── orders/            # Orders pages (list, new, detail)
│   ├── layout.tsx         # Root layout
│   └── page.tsx           # Home page (redirects to dashboard)
├── components/            # React components
│   ├── Navbar.tsx
│   ├── MilestoneCard.tsx
│   ├── OrderTimeline.tsx
│   ├── MilestoneActions.tsx
│   └── DelayRequestForm.tsx
├── lib/
│   ├── supabase/          # Supabase client setup
│   ├── types.ts           # TypeScript type definitions
│   └── utils/             # Utility functions
│       ├── auth.ts        # Email validation
│       ├── date.ts        # Date utilities
│       ├── notifications.ts  # Email and notification system
│       └── time-decomposition.ts  # Milestone scheduling engine
├── supabase/
│   └── migration.sql      # Database migration
├── middleware.ts          # Next.js middleware (auth protection)
└── README.md
```

## Key Features Explained

### Time Decomposition Engine

The time decomposition engine automatically calculates milestone dates by backward scheduling from the target date (ETD for FOB, Warehouse Due Date for DDP). It:

- Handles business days (excludes weekends)
- Adjusts packaging materials timing based on packaging type (standard vs custom)
- Calculates planned_at and due_at for each milestone
- Respects internal controls (PO+2 workdays for procurement/finance, PO+3 workdays for order/production/packaging)

### Status Machine

- **Done**: Automatically advances to the next milestone
- **Blocked**: Requires reason and note; prevents progression
- **Overdue**: Automatically detected based on due date
- **In Progress**: Milestone is actively being worked on
- **Pending**: Milestone is waiting to start

### Delay Management

- Users can request delays for milestones with reason
- Delay requests require approval from milestone owner or admin
- On approval, downstream milestones are automatically recalculated
- All delay requests are logged for audit trail

### Notifications

- **Email**: Sent via SMTP (Tencent enterprise mail)
- **In-app**: Stored in notifications table
- **Reminders**: 48/24/12 hours before due date
- **Escalation**: Overdue/blocked milestones escalate to su@qimoclothing.com and alex@qimoclothing.com

## Pages

- `/login` - Login/Signup page
- `/dashboard` - My Beats (user's assigned milestones)
- `/orders` - Orders list
- `/orders/new` - Create new order
- `/orders/[id]` - Order detail with timeline, logs, and attachments
- `/admin` - Admin dashboard (risk/overdue list, bottleneck analysis)

## Development

```bash
# Development server
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Lint
npm run lint
```

## Deployment

### Vercel (Recommended)

1. Push code to GitHub
2. Import project in Vercel
3. Add environment variables
4. Deploy

### Other Platforms

The app can be deployed to any platform supporting Next.js. Ensure all environment variables are set correctly.

## License

MIT
