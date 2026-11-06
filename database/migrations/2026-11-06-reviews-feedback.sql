-- =========================================================
-- Reviews & Feedback: products, feedback, attachments, responses,
-- internal notes and testimonials.
--
-- Safe to run more than once. Adds new tables only; existing tables (including
-- the existing client "reviews") are not changed. Take a backup first
-- (Supabase Dashboard > Database > Backups), then run this in the SQL Editor.
-- Until it is run, the feedback page says feedback isn't open yet and the
-- dashboard asks for this update.
-- =========================================================

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  name text not null,
  description text,
  logo_url text,
  website_url text,
  is_active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
create unique index if not exists products_slug_key on products (slug);

-- The products named by SHEREBOY TECH LTD. Descriptions, logos and links are added
-- in the dashboard; nothing about them is assumed here.
insert into products (slug, name, display_order) values
  ('job-rush', 'JOB RUSH', 1),
  ('achiever', 'ACHIEVER', 2),
  ('shereblognews', 'SHEREBLOGNEWS', 3)
on conflict (slug) do nothing;

create table if not exists feedback (
  id uuid primary key default gen_random_uuid(),
  reference text not null,
  product_id uuid not null references products (id) on delete restrict,
  name text,
  email text,
  rating integer not null check (rating between 1 and 5),
  category text not null check (category in ('general', 'bug', 'feature', 'complaint', 'suggestion', 'ux', 'other')),
  subject text not null,
  message text not null,
  allow_publish boolean not null default false,
  status text not null default 'new'
    check (status in ('new', 'under_review', 'in_progress', 'responded', 'resolved', 'archived')),
  is_read boolean not null default false,
  suspected_spam boolean not null default false,
  submitter_hash text,
  content_hash text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists feedback_reference_key on feedback (reference);
create index if not exists feedback_product_idx on feedback (product_id, created_at desc);
create index if not exists feedback_status_idx on feedback (status, created_at desc);
create index if not exists feedback_created_idx on feedback (created_at desc);
create index if not exists feedback_duplicate_idx on feedback (submitter_hash, content_hash);

create table if not exists feedback_attachments (
  id uuid primary key default gen_random_uuid(),
  feedback_id uuid not null references feedback (id) on delete cascade,
  bucket text not null,
  storage_path text not null,
  file_name text not null,
  mime_type text not null,
  size_bytes integer not null,
  created_at timestamptz not null default now()
);
create index if not exists feedback_attachments_feedback_idx on feedback_attachments (feedback_id);

create table if not exists feedback_responses (
  id uuid primary key default gen_random_uuid(),
  feedback_id uuid not null references feedback (id) on delete cascade,
  message text not null,
  admin_username text not null,
  email_status text not null default 'not_sent' check (email_status in ('not_sent', 'accepted', 'failed')),
  email_error text,
  created_at timestamptz not null default now()
);
create index if not exists feedback_responses_feedback_idx on feedback_responses (feedback_id, created_at);

create table if not exists feedback_internal_notes (
  id uuid primary key default gen_random_uuid(),
  feedback_id uuid not null references feedback (id) on delete cascade,
  note text not null,
  admin_username text not null,
  created_at timestamptz not null default now()
);
create index if not exists feedback_notes_feedback_idx on feedback_internal_notes (feedback_id, created_at);

-- Created only when the customer allowed public use; published only after approval
create table if not exists testimonials (
  id uuid primary key default gen_random_uuid(),
  feedback_id uuid not null references feedback (id) on delete cascade,
  product_id uuid not null references products (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'unpublished')),
  featured boolean not null default false,
  display_name text not null,
  quote text not null,
  rating integer not null check (rating between 1 and 5),
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists testimonials_feedback_key on testimonials (feedback_id);
create index if not exists testimonials_status_idx on testimonials (status, featured);

-- The server uses the service role key, which bypasses RLS. With RLS on and no
-- policies, none of this can be read with the public anon key.
alter table products enable row level security;
alter table feedback enable row level security;
alter table feedback_attachments enable row level security;
alter table feedback_responses enable row level security;
alter table feedback_internal_notes enable row level security;
alter table testimonials enable row level security;
