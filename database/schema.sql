-- =========================================================
-- SHEREBOY TECH LTD — Database Schema (Supabase / PostgreSQL)
-- Run this in the Supabase SQL Editor (Project > SQL Editor > New Query)
-- =========================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------
-- USERS (admin accounts)
-- ---------------------------------------------------------
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  username text unique not null,
  password_hash text not null,
  role text not null default 'admin',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------
-- COMPANY SETTINGS (single row, key/value style is overkill here —
-- we use one row table so the admin can edit everything in one place)
-- ---------------------------------------------------------
create table if not exists company_settings (
  id int primary key default 1,
  company_name text default 'SHEREBOY TECH LTD',
  description text,
  mission text,
  vision text,
  address text,
  cac_number text,
  cac_document_url text,
  ceo_name text default 'BAWO MADAMEDON',
  ceo_title text default 'CEO, SHEREBOY TECH LTD',
  ceo_bio text,
  ceo_photo_url text,
  logo_url text,
  email text default 'shereboyofficial1515@gmail.com',
  whatsapp text default '08124529757',
  phone text default '07010288040',
  instagram_url text default 'PLACEHOLDER_INSTAGRAM_URL',
  tiktok_url text default 'PLACEHOLDER_TIKTOK_URL',
  youtube_url text default 'PLACEHOLDER_YOUTUBE_URL',
  updated_at timestamptz not null default now(),
  constraint single_row check (id = 1)
);
insert into company_settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------
-- SERVICES
-- ---------------------------------------------------------
create table if not exists services (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  icon text,
  display_order int default 0,
  published boolean default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------
-- PROJECTS / PORTFOLIO
-- ---------------------------------------------------------
create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  category text,
  image_url text,
  technologies text[], -- array of tech names
  client_name text,
  completion_date date,
  status text default 'completed', -- completed | in_progress | maintenance
  live_url text,
  github_url text,
  featured boolean default false,
  published boolean default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_projects_published on projects(published);
create index if not exists idx_projects_featured on projects(featured);

-- ---------------------------------------------------------
-- REVIEWS / TESTIMONIALS
-- ---------------------------------------------------------
create table if not exists reviews (
  id uuid primary key default gen_random_uuid(),
  client_name text not null,
  client_position text,
  review_text text not null,
  client_image_url text,
  rating int check (rating between 1 and 5) default 5,
  featured boolean default false,
  published boolean default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_reviews_published on reviews(published);

-- ---------------------------------------------------------
-- BLOG: CATEGORIES / TAGS / POSTS
-- ---------------------------------------------------------
create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  slug text unique not null,
  created_at timestamptz not null default now()
);

create table if not exists tags (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  slug text unique not null,
  created_at timestamptz not null default now()
);

create table if not exists blog_posts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text unique not null,
  excerpt text,
  content text not null,
  featured_image_url text,
  category_id uuid references categories(id) on delete set null,
  author text default 'SHEREBOY TECH LTD',
  featured boolean default false,
  published boolean default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_blog_published on blog_posts(published);
create index if not exists idx_blog_slug on blog_posts(slug);

create table if not exists blog_tags (
  post_id uuid references blog_posts(id) on delete cascade,
  tag_id uuid references tags(id) on delete cascade,
  primary key (post_id, tag_id)
);

-- ---------------------------------------------------------
-- ADMIN SESSIONS (optional — only needed if not using
-- connect-pg-simple / memory store for express-session)
-- ---------------------------------------------------------
create table if not exists admin_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  token text unique not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------
-- ACTIVITY LOG
-- ---------------------------------------------------------
create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  action text not null,
  details text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------
-- AI CHAT LOG (optional, useful for abuse monitoring — no secrets stored)
-- ---------------------------------------------------------
create table if not exists ai_chat_log (
  id uuid primary key default gen_random_uuid(),
  ip_hash text,
  message_preview text,
  created_at timestamptz not null default now()
);
