-- =========================================================
-- MIGRATION: add contact_messages table
-- Run this in Supabase SQL Editor if your database already exists
-- and you don't want to re-run the full schema.sql
-- =========================================================

create table if not exists contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  phone text,
  subject text,
  message text not null,
  read boolean default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_contact_read on contact_messages(read);