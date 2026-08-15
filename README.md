# SHEREBOY TECH LTD — Full-Stack Company Website

A complete company website for **SHEREBOY TECH LTD**: public marketing site, dynamic
projects/blog/reviews/services, an admin dashboard, and a Gemini-powered "SHEREBOY AI
Assistant" — all served from a single Node.js/Express app, backed by Supabase (PostgreSQL).

Stack: **HTML/CSS/vanilla JS** (frontend) · **Node.js/Express** (backend) · **Supabase
PostgreSQL** (database + storage) · **Gemini API** (AI assistant) · **Render** (hosting).

---

## 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) → **New project**.
2. Choose a name, database password, and region. Wait for it to finish provisioning.
3. In **Project Settings → API**, copy:
   - **Project URL** → this is your `SUPABASE_URL`
   - **service_role key** (NOT the `anon` key) → this is your `SUPABASE_SERVICE_ROLE_KEY`

   ⚠️ The service role key bypasses all row-level security and must **only** ever live in
   your server's `.env` file — never in frontend code, never committed to Git.

## 2. Create the database tables

1. In your Supabase project, open **SQL Editor → New query**.
2. Open `database/schema.sql` from this project, paste its full contents in, and click **Run**.
3. This creates all tables: `users`, `company_settings`, `services`, `projects`, `reviews`,
   `blog_posts`, `categories`, `tags`, `blog_tags`, `admin_sessions`, `activity_log`, `ai_chat_log`.

## 3. Configure Supabase Storage (for images)

1. In Supabase, go to **Storage → Create a new bucket**.
2. Name it `sheroboytech-media` (or choose your own name — just set
   `SUPABASE_STORAGE_BUCKET` in `.env` to match).
3. Make the bucket **public** (so uploaded images can be displayed on the website).
4. That's it — the backend (`server/routes/upload.js`) handles all uploads through this bucket;
   the browser never talks to Supabase Storage directly.

## 4. Get a Gemini API key

1. Go to [Google AI Studio](https://aistudio.google.com/) → **Get API key** → create a key.
2. Copy the key.

## 5. Where to place the Gemini API key

Put it **only** in your `.env` file (or Render's environment variable settings) as:

```
GEMINI_API_KEY=your_real_key_here
```

It is read exclusively by `server/routes/aiChat.js` on the backend. The browser only ever
calls `POST /api/ai/chat` on your own server — it never sees this key.

## 6. Configure environment variables

Copy `.env.example` to `.env` and fill in real values:

```bash
cp .env.example .env
```

| Variable | Where to get it |
|---|---|
| `SUPABASE_URL` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API |
| `SUPABASE_STORAGE_BUCKET` | The bucket name you created (step 3) |
| `GEMINI_API_KEY` | Google AI Studio |
| `SESSION_SECRET` | Any long random string (e.g. `openssl rand -hex 32`) |
| `ADMIN_USERNAME` | Whatever username you want to log in with |
| `ADMIN_PASSWORD_HASH` | See step 9 below |

## 7. Run locally

```bash
npm install
npm start
```

The site runs at `http://localhost:10000` (or whatever `PORT` you set).

## 8. Deploy to Render

1. Push this project to a GitHub repository (the `.gitignore` already excludes `.env` and
   `node_modules`).
2. In [Render](https://render.com), click **New → Web Service**, connect your repo.
3. Render will detect `render.yaml` automatically. Otherwise set manually:
   - Build command: `npm install`
   - Start command: `npm start`
4. In the Render dashboard, add the environment variables from your `.env` (Render marks
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `ADMIN_USERNAME`,
   `ADMIN_PASSWORD_HASH` as "sync: false" so you must enter them manually in the dashboard —
   this keeps them out of your Git repo).
5. Deploy. Render provides `PORT` automatically; the app reads it via `process.env.PORT`.

## 9. Create the first admin account

You don't need a signup form — the admin account is defined entirely through environment
variables (`ADMIN_USERNAME` + `ADMIN_PASSWORD_HASH`).

1. Choose a username and a strong password.
2. Generate the bcrypt hash of your password:

   ```bash
   node scripts/hash-password.js "your-chosen-password"
   ```

3. Copy the printed hash into `ADMIN_PASSWORD_HASH` in `.env` (or Render's env vars).
4. Set `ADMIN_USERNAME` to your chosen username.
5. Log in at `/admin/login` (this loads the same page as `/admin` — the login screen shows
   automatically until you're authenticated).

You can add more admins later by inserting rows into the `users` table (`password_hash` must
be a bcrypt hash, same as above) — the login system checks both the env-based root admin and
the `users` table.

## 10. How to change company information

Log into `/admin`, go to **Company Settings**. Update the description, mission, vision,
CEO info, CAC number, contact details, and social links (`instagram_url`, `tiktok_url`,
`youtube_url` — replace the `PLACEHOLDER_...` values once you have the real URLs). Changes
save immediately to Supabase and appear on the public site right away.

## 11. How to add projects

`/admin` → **Projects** → **+ New project**. Fill in the title, category, description,
image URL, technologies (comma-separated), client name, and — most importantly — the
**Live project URL**. Toggle **Published** to make it visible on the public site, and
**Featured** to show it in the homepage's featured section.

> Tip: upload an image first via the browser's dev tools calling `POST /api/upload`, or
> host images externally and paste the URL — a dedicated "upload" button can be wired into
> the project form UI as a future enhancement.

## 12. How to add blog posts

`/admin` → **Blog** → **+ New post**. Leave the slug blank to auto-generate one from the
title. Write content as HTML in the content field. Toggle **Published** when ready — drafts
stay hidden from the public `/blog` listing until then.

## 13. How to add reviews

`/admin` → **Reviews** → **+ New review**. Reviews are unpublished by default so you can
review submissions before they go live — toggle **Published** to display them publicly, and
**Featured** to highlight them.

---

## Project structure

```
sheroboytech/
├── public/                  # Frontend (HTML/CSS/vanilla JS)
│   ├── index.html
│   ├── css/style.css
│   ├── js/app.js
│   ├── admin/                # Admin dashboard (not linked from public nav)
│   │   ├── index.html
│   │   ├── admin.css
│   │   └── admin.js
│   ├── robots.txt
│   └── sitemap.xml
├── server/
│   ├── server.js             # App entry point
│   ├── database.js           # Supabase client (service role — backend only)
│   ├── auth.js                # Login/logout/session logic
│   ├── activityLog.js
│   ├── middleware/security.js # Rate limiting + input sanitizing
│   └── routes/
│       ├── auth.js
│       ├── projects.js
│       ├── reviews.js
│       ├── blog.js
│       ├── services.js
│       ├── company.js
│       ├── aiChat.js          # Secure Gemini proxy
│       ├── dashboard.js
│       └── upload.js
├── database/schema.sql        # Run once in Supabase SQL Editor
├── scripts/hash-password.js   # Generates bcrypt hash for admin password
├── .env.example
├── render.yaml
└── package.json
```

## Security notes

- The Supabase **service role key** and **Gemini API key** are read only from `process.env`
  on the backend — never sent to the browser, never in frontend files, never logged.
- Admin routes require an authenticated session (`express-session`, HTTP-only cookies).
- Passwords are hashed with bcrypt; plaintext passwords are never stored.
- Login attempts are rate-limited; the AI chat endpoint has its own stricter rate limit.
- All admin write endpoints re-validate input server-side, regardless of frontend checks.
- The admin dashboard is not linked from the public navigation and isn't the primary
  security mechanism — authentication is.

## Notes on placeholders

Fields like `[COMPANY ADDRESS]`, `[CEO BIO]`, `[INSERT CAC NUMBER HERE]`, and the
`PLACEHOLDER_INSTAGRAM_URL` / `PLACEHOLDER_TIKTOK_URL` / `PLACEHOLDER_YOUTUBE_URL` values in
`company_settings` are intentional — replace them from **Company Settings** in the admin
dashboard once you have the real information. Nothing was invented.
