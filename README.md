# Orange Funeral — Live Stream Link Creation

A small, self-contained web app for streaming funeral services:

- Your 2 streaming staff log into `/admin`, paste in the **YoloLive embed code**
  for a service, and the app instantly creates a public page with its own link
  — e.g. `https://yourdomain.com/watch/service-for-jane-doe-6hynxz`.
- Visitors must enter their **name and email** before the video appears. That
  email is saved, tied to *that specific stream*, and reused if they've
  watched before.
- Every stream page has **live chat**, built in — no third-party widget.
- When staff click **"End Stream"**, a **thank-you email** automatically goes
  out to everyone who watched that stream (via Everlytic).
- Staff can send a **broadcast email** to everyone who has ever watched any
  stream, from `/admin/broadcast`.
- Every email includes an unsubscribe link, and unsubscribed contacts are
  automatically skipped for both thank-you and broadcast sends.

Everything lives in one SQLite database file — there's no separate database
server to set up, patch, or pay for.

---

## 1. Local setup (to try it out / develop)

```bash
npm install
cp .env.example .env      # then fill in the values, see below
npm run setup              # creates your first staff login (interactive)
npm run dev                 # starts the app at http://localhost:3000
```

Open `http://localhost:3000/admin/login` and sign in with the account you
just created.

### Filling in `.env`

| Variable | What it is |
|---|---|
| `DATABASE_FILE` | Where the SQLite file lives. Leave as-is locally. |
| `SESSION_SECRET` | Any long random string — run `openssl rand -hex 32`. |
| `BASE_URL` | The real public URL people will use once deployed, e.g. `https://watch.yourfuneralhome.com`. This is used to build unsubscribe links in emails, so keep it accurate. |
| `EVERLYTIC_BASE_URL` / `EVERLYTIC_USERNAME` / `EVERLYTIC_API_KEY` | Your Everlytic account credentials. See step 3 below. |
| `EMAIL_FROM_ADDRESS` / `EMAIL_FROM_NAME` | Who thank-you/broadcast emails appear to come from — set up as part of Everlytic onboarding. |

Run `npm run setup` again any time to add a login for your second staff member.

---

## 2. Deploying so it's a real, public website

GoDaddy's basic "shared hosting" (cPanel) only runs PHP — it **cannot** run
this app, because live chat needs a server that stays running and holds live
connections, which shared hosting doesn't support.

**GitHub and Render do two different jobs here, and you need both:**
GitHub just stores the code (like a folder with version history — it doesn't
run anything or serve web pages for an app like this; GitHub Pages, the part
of GitHub that *does* serve pages, only serves static files and can't run a
database, login system, or live chat). Render is what actually **runs** the
app around the clock. The normal setup is: code lives in a GitHub repo,
Render watches that repo and runs it, and your GoDaddy domain points at
Render. Visitors just see your domain — they never see GitHub or Render.

### Step 1 — get the code onto GitHub (no `git` needed)

1. Unzip the project you were sent, if you haven't already.
2. On github.com, click **New repository**. Name it e.g. `funeral-streams`,
   set it to **Private**, and leave every "initialize with..." checkbox
   **unchecked**. Click **Create repository**.
3. On the empty repo page that appears, click the **"uploading an existing
   file"** link.
4. Open the unzipped `funeral-streams` folder on your computer and drag
   **everything inside it** (`src`, `package.json`, `package-lock.json`,
   `README.md`, `.gitignore`, `.env.example`) into the browser — not the
   outer `funeral-streams` folder itself, its *contents*, so these files end
   up at the top level of the repo. There's no `node_modules` folder to
   worry about excluding — it isn't included in what you were sent.
5. Scroll down, click **Commit changes**. Your code is now on GitHub.

### Step 2 — deploy it on Render

1. On render.com, click **New → Web Service**, and connect the GitHub repo
   you just created.
2. Build command: `npm install`. Start command: `npm start`.
3. Instance type: **Free** is fine for testing today (see the note below on
   its limits). Give the service a name — that becomes part of its test URL,
   e.g. naming it `funeral-streams` gives you `funeral-streams.onrender.com`.
4. Under **Environment**, add these variables (see `.env.example` for the
   full list/explanations):
   - `SESSION_SECRET` — any long random string.
   - `BASE_URL` — set to the `onrender.com` URL from step 3 once you know it
     (you can create the service first, see the URL, then add this and it'll
     redeploy).
   - `DATABASE_FILE` — leave as `./data/funeral-streams.db` for a free-tier
     test (see note below).
   - `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` — **use these instead of
     `npm run setup`.** Render's free tier has no Shell access, so this is
     how you get a login on a free instance — the app creates it
     automatically on startup. Pick a real password; you'll use it to log in.
   - Leave the `EVERLYTIC_*` variables out for now if you don't have them
     yet — thank-you/broadcast emails will just fail quietly (logged, not
     crashing) until you add them.
5. Click **Create Web Service**. Render builds and deploys — takes a couple
   of minutes the first time.
6. Once it's live, visit `https://your-service-name.onrender.com/admin/login`
   and sign in with the `ADMIN_EMAIL`/`ADMIN_PASSWORD` you set. You're testing.

### A real limit of Render's free tier, so today's test doesn't confuse you

Free web services on Render have **no persistent disk and no Shell access**.
Two consequences worth knowing before you click around:

- **Data doesn't survive a restart.** Free services "spin down" after 15
  minutes with no visitors and spin back up (taking about a minute) on the
  next visit — and spinning back up means a **fresh, empty database**. Any
  test streams, chat messages, or emails you created will be gone. This is
  fine for today's click-through test; it is **not** fine for an actual
  funeral service. The `ADMIN_*` environment variables mean you can always
  log back in even after a reset, though — you don't get locked out.
- **This is exactly why we added the `ADMIN_*` login variables above** —
  without them, a reset with no Shell access would mean no way to create a
  new login at all.

**Before using this for a real service:** upgrade the Render instance to
**Starter** (~$7/month) and add a **persistent disk** (Render's dashboard
has both options right on the service's settings) — that's what makes data
actually stick around between restarts. At that point you'd also switch
`DATABASE_FILE` to point at the mounted disk path (e.g.
`/data/funeral-streams.db`) so it survives redeploys too. Worth doing well
before your first real livestream, not the night before.

Once you have your GoDaddy domain, adding it is one more step in Render
(**Settings → Custom Domain**, which gives you a DNS record) plus adding
that record in your **GoDaddy DNS settings** (Domain → DNS → Manage) — happy
to walk through that when you're there.

Railway and Fly.io work the same way if you'd rather use one of those
instead of Render.

### Sizing

This is built for the traffic a funeral home actually gets — dozens to a
few hundred concurrent viewers per service, not millions. Render's $7/month
Starter tier is comfortably enough once you're live for real.

---

## 3. Setting up Everlytic (email sending)

Everlytic doesn't have a free self-signup tier the way most email APIs do —
you'll need to talk to their sales/onboarding team to open an account and
agree a plan (South African company, billed in ZAR, priced by subscriber
count). Once you have an account:

1. Get your **API key** and **username** from Everlytic (ask your onboarding
   contact if it's not obvious where in their dashboard this lives).
2. Get your account's **base URL** — Everlytic is multi-tenant, so unlike
   most email APIs, requests go to *your* installation's own domain, not a
   shared `api.everlytic.com`-style URL. Your onboarding contact can confirm
   this.
3. Set up your **sending domain/from address** with Everlytic as part of
   onboarding, so `notifications@yourfuneralhome.com` (or whatever you use)
   is authenticated and doesn't land in spam.
4. Put all three into `.env`: `EVERLYTIC_BASE_URL`, `EVERLYTIC_USERNAME`,
   `EVERLYTIC_API_KEY`.
5. No mailing list import needed — contacts are added to this app's own
   database automatically the moment someone enters their email to watch a
   stream. Everlytic is only used to actually send the emails.

**Worth double-checking on your first real send:** Everlytic's public API
docs describe the transactional email request's fields but don't publish a
full copy-pasteable JSON example, so `src/lib/mailer.js` was built from
their field descriptions rather than a verified sample. Send yourself a test
thank-you email first (end a test stream you've watched yourself) and check
it arrives correctly before relying on it for a real service. If a field
needs adjusting, Everlytic's support team can confirm the exact shape from
your account's own docs — the mailer is a single, small function, so it's a
quick fix either way.

---

## 4. Day-to-day use for your streaming staff

1. Set up the stream on the YoloBox and start it in YoloLive, as normal.
2. Copy the **embed code** YoloLive gives you for that stream.
3. Go to `yourdomain.com/admin`, log in, click **New Livestream**.
4. Enter a title (e.g. "Service for Jane Doe"), paste the embed code, save.
5. You'll land on that stream's page with its public link — copy it and
   send it to the family / post it wherever people will find it.
6. When the service is over, open that stream in `/admin` and click **End
   Stream & Send Thank-You Emails**. This is a manual step by design — it's
   what triggers the thank-you email, so it only goes out once you confirm
   the service has actually ended.

To email everyone who has ever watched any stream (e.g. a general update or
holiday message), use **Broadcast Email** in the admin menu.

---

## 5. What's deliberately simple here (and how to extend it)

- **Staff accounts** are created via `npm run setup` (interactive) or the
  `ADMIN_*` environment variables (automatic on every boot — see "Deploying"
  above), not a self-service signup page — there are only 2 of you, so this
  avoids building account management you don't need yet.
- **Embed code is trusted input.** It's only staff (who you've given
  logins to) who can submit it, so it's stored and displayed as-is rather
  than heavily sanitized. Don't expose stream creation to anyone you don't
  trust.
- **Chat has no moderation tools yet** (e.g. deleting a message, muting
  someone). Given funeral audiences this is usually fine, but it's a
  natural next feature if you ever need it.
- **One SQLite file is the whole database.** This is simple and completely
  sufficient at this scale. If you ever need multiple servers running at
  once for very high traffic, that's the point where you'd migrate to a
  hosted Postgres database — worth knowing, not worth building now.

---

## 6. Project structure

```
src/
  server.js            # entry point: Express app + Socket.io chat
  lib/
    db.js               # SQLite connection + schema
    auth.js              # staff login middleware
    mailer.js             # Everlytic API wrapper
    emailService.js        # thank-you + broadcast sending logic
    emailTemplates.js       # email HTML
    slug.js                  # unique link generation
    setup.js                  # `npm run setup` — create staff logins
  routes/
    admin.js             # staff portal: login, dashboard, new stream, broadcast
    watch.js              # public email-gated stream page
    unsubscribe.js         # unsubscribe link handler
  views/                  # EJS templates
  public/                  # CSS + chat client-side JS
```

---

## 7. Sending contacts to the Orange Platform CRM

Everyone who enters their email on a watch page, everyone billed on a funeral quote or
invoice, and every unsubscribe is sent to the **Contacts** page in Orange Platform
automatically, usually within a couple of seconds. The watch page never waits for it: each
email goes into a small `crm_outbox` table first and is sent in the background, retried
every 5 minutes if the platform can't be reached.

Switch it on in Render → this service → **Environment**:

| Variable | Value |
|---|---|
| `CRM_SUPABASE_URL` | Orange Platform's Supabase Project URL (the `url` in the platform's `config.js`) |
| `CRM_SUPABASE_KEY` | Orange Platform's publishable / anon key (the `key` in `config.js`) |
| `CRM_INGEST_SECRET` | The value Supabase returned when you created the `funerals` row in `crm_secrets` (see the platform README) |

The first time it starts with these set, it sends everyone already in the database once.
**Settings** shows whether the sync is on, how many are waiting, and the last problem, and
has a **Send everyone again** button for after a fix. The code is in `src/lib/crmSync.js`.
