-- =========================================================
-- Email marketing: subscribers, consent, suppressions, templates, campaigns,
-- per-recipient delivery records, webhook events and email settings.
--
-- Safe to run more than once. Adds new tables only; changes no existing data.
-- Take a backup first (Supabase Dashboard > Database > Backups), then run this
-- in the SQL Editor. The website keeps working until you do: the newsletter form
-- says it isn't open yet, and the admin area asks for this update.
-- =========================================================

create table if not exists email_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  first_name text,
  status text not null default 'pending'
    check (status in ('pending', 'active', 'unsubscribed', 'bounced', 'complained', 'suppressed')),
  consent_status text not null default 'requested'
    check (consent_status in ('requested', 'confirmed', 'withdrawn')),
  consent_timestamp timestamptz,
  consent_text text,
  signup_source text,
  confirmation_token_hash text,
  confirmation_expires_at timestamptz,
  confirmation_sent_at timestamptz,
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  unsubscribe_source text,
  resend_contact_id text,
  resend_sync_needed boolean not null default false,
  last_email_at timestamptz,
  last_event text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_subscribers_email_lowercase check (email = lower(email))
);
create unique index if not exists email_subscribers_email_key on email_subscribers (email);
create unique index if not exists email_subscribers_token_key on email_subscribers (confirmation_token_hash) where confirmation_token_hash is not null;
create index if not exists email_subscribers_status_idx on email_subscribers (status, created_at desc);
create index if not exists email_subscribers_source_idx on email_subscribers (signup_source);
create index if not exists email_subscribers_sync_idx on email_subscribers (resend_sync_needed) where resend_sync_needed;

-- Never mailed again, even if the subscriber record is later removed
create table if not exists email_suppressions (
  email text primary key check (email = lower(email)),
  reason text not null check (reason in ('unsubscribed', 'bounced', 'complained', 'manual')),
  source text,
  created_at timestamptz not null default now()
);

create table if not exists email_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text,
  name text not null,
  category text,
  subject text not null default '',
  preheader text,
  body_html text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists email_templates_key on email_templates (template_key) where template_key is not null;

create table if not exists email_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  mode text not null default 'newsletter' check (mode in ('newsletter', 'individual')),
  subject text not null default '',
  preheader text,
  body_html text not null default '',
  reply_to text,
  audience jsonb not null default '{}',
  status text not null default 'draft'
    check (status in ('draft', 'scheduled', 'queued', 'sending', 'completed', 'failed', 'cancelled')),
  scheduled_at timestamptz,
  queued_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  next_run_at timestamptz,
  retry_count integer not null default 0,
  recipients_built boolean not null default false,
  recipient_count integer not null default 0,
  stats jsonb not null default '{}',
  last_error text,
  acknowledged_by text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists email_campaigns_status_idx on email_campaigns (status, next_run_at);
create index if not exists email_campaigns_created_idx on email_campaigns (created_at desc);

create table if not exists email_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references email_campaigns (id) on delete cascade,
  subscriber_id uuid references email_subscribers (id) on delete set null,
  email text not null,
  first_name text,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'accepted', 'delayed', 'delivered', 'bounced', 'complained', 'failed', 'skipped')),
  batch_key text,
  claimed_at timestamptz,
  attempts integer not null default 0,
  provider_id text,
  accepted_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One person can never be queued twice for the same campaign
  constraint email_campaign_recipients_once unique (campaign_id, email)
);
create index if not exists email_recipients_campaign_status_idx on email_campaign_recipients (campaign_id, status);
create index if not exists email_recipients_provider_idx on email_campaign_recipients (provider_id);
create index if not exists email_recipients_email_idx on email_campaign_recipients (email);

create table if not exists email_events (
  id uuid primary key default gen_random_uuid(),
  -- The webhook delivery id: a repeated delivery can't be counted twice
  event_key text not null,
  type text not null,
  provider_id text,
  email text,
  campaign_id uuid references email_campaigns (id) on delete set null,
  detail text,
  occurred_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists email_events_key on email_events (event_key);
create index if not exists email_events_email_idx on email_events (email, created_at desc);

create table if not exists email_settings (
  id integer primary key default 1 check (id = 1),
  sender_name text,
  sender_email text,
  reply_to text,
  newsletter_description text,
  confirmation_subject text,
  confirmation_intro text,
  confirmation_expiry_hours integer,
  welcome_enabled boolean not null default true,
  welcome_subject text,
  welcome_body text,
  footer_text text,
  logo_url text,
  contact_address text,
  contact_email text,
  contact_phone text,
  updated_at timestamptz not null default now()
);

-- The website's server uses the service role key, which bypasses RLS. With RLS
-- on and no policies, subscriber data can't be reached with the public anon key.
alter table email_subscribers enable row level security;
alter table email_suppressions enable row level security;
alter table email_templates enable row level security;
alter table email_campaigns enable row level security;
alter table email_campaign_recipients enable row level security;
alter table email_events enable row level security;
alter table email_settings enable row level security;
