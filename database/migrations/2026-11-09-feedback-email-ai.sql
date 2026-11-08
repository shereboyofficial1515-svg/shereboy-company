-- =========================================================
-- Reviews & Feedback: customer emails and the AI assistant.
--
--  * Confirmation email status on each feedback, so failed confirmations can be
--    retried without creating a second feedback record.
--  * AI analysis on each feedback: classification, sentiment, summary, suggested
--    follow-up questions, and whether it needs an administrator.
--  * feedback_emails: every email sent to a customer about a ticket (confirmation,
--    replies, information requests, status updates, AI replies), with its delivery
--    status, plus customer replies recorded by staff. This is the conversation history.
--  * feedback_ai_settings: automatic AI replies (off by default) and whether an
--    administrator must approve them (on by default).
--  * feedback_ai_log: what the AI did and who asked it to.
--
-- Run 2026-11-06-reviews-feedback.sql and 2026-11-08-feedback-from-apps.sql first.
-- Safe to run more than once. Adds columns and tables only; no existing data changes.
-- Take a backup first, then run this in the Supabase SQL Editor.
-- =========================================================

alter table feedback add column if not exists confirmation_status text not null default 'not_required'
  check (confirmation_status in ('not_required', 'pending', 'sent', 'failed'));
alter table feedback add column if not exists confirmation_attempts integer not null default 0;
alter table feedback add column if not exists confirmation_error text;
alter table feedback add column if not exists confirmation_sent_at timestamptz;

alter table feedback add column if not exists ai_classification text
  check (ai_classification in ('complaint', 'suggestion', 'question', 'positive_review', 'general_enquiry'));
alter table feedback add column if not exists sentiment text check (sentiment in ('positive', 'neutral', 'negative'));
alter table feedback add column if not exists ai_summary text;
alter table feedback add column if not exists ai_follow_up_questions jsonb not null default '[]'::jsonb;
alter table feedback add column if not exists ai_suggested_reply text;
alter table feedback add column if not exists needs_attention boolean not null default false;
alter table feedback add column if not exists attention_reason text;
alter table feedback add column if not exists ai_status text not null default 'pending'
  check (ai_status in ('pending', 'done', 'failed', 'off'));
alter table feedback add column if not exists ai_analyzed_at timestamptz;
alter table feedback add column if not exists ai_handled boolean not null default false;
alter table feedback add column if not exists awaiting_customer boolean not null default false;

create index if not exists feedback_attention_idx on feedback (needs_attention) where needs_attention;
create index if not exists feedback_confirmation_idx on feedback (confirmation_status) where confirmation_status in ('pending', 'failed');
create index if not exists feedback_sentiment_idx on feedback (sentiment);

create table if not exists feedback_emails (
  id uuid primary key default gen_random_uuid(),
  feedback_id uuid not null references feedback (id) on delete cascade,
  direction text not null default 'outbound' check (direction in ('outbound', 'inbound')),
  kind text not null check (kind in ('confirmation', 'reply', 'info_request', 'follow_up', 'under_review', 'resolved', 'ai_reply', 'customer_reply')),
  subject text not null,
  body text not null,
  to_email text,
  author text not null,
  ai_generated boolean not null default false,
  status text not null check (status in ('pending_approval', 'sending', 'sent', 'failed', 'discarded', 'received')),
  error text,
  attempts integer not null default 0,
  provider_id text,
  approved_by text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists feedback_emails_feedback_idx on feedback_emails (feedback_id, created_at);
create index if not exists feedback_emails_status_idx on feedback_emails (status, created_at desc);

create table if not exists feedback_ai_settings (
  id integer primary key default 1 check (id = 1),
  auto_reply_enabled boolean not null default false,
  require_approval boolean not null default true,
  status_emails_enabled boolean not null default true,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into feedback_ai_settings (id) values (1) on conflict (id) do nothing;

create table if not exists feedback_ai_log (
  id uuid primary key default gen_random_uuid(),
  feedback_id uuid references feedback (id) on delete set null,
  action text not null,
  actor text not null,
  outcome text not null check (outcome in ('ok', 'failed', 'held')),
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists feedback_ai_log_created_idx on feedback_ai_log (created_at desc);

-- The server uses the service role key, which bypasses RLS. With RLS on and no
-- policies, none of this can be read or written with the public anon key.
alter table feedback_emails enable row level security;
alter table feedback_ai_settings enable row level security;
alter table feedback_ai_log enable row level security;
