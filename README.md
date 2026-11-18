# Video Publishing App — hosted copy (deploy-ready)

This is a faithful, deploy-ready copy of the Muse fullstack app
(slug `video-publishing-app`, live version v3). The Muse original is
**untouched** and stays as the private/backup copy. This copy starts
**empty** — it does NOT carry over any real client created in Muse,
because the Muse fullstack source and its database cannot be exported
(see "Why this is a copy, not a move" below). Do not invent or copy
real client data into it; Michael creates the first live client here
after deployment, and that client gets a fresh account number and code.

## Version badge — so Michael is never confused

Always visible at the very top of the page, in the sticky header, on
the first screen, the coordinator desk, and the client page. It is
**not** hidden in a menu.

- **Hosted deployment:** green dot + `● LIVE` (green `#16a34a` on light green)
- **Muse version:** `◆ MUSE — TEST / FIXING` (amber `#b45309` on light amber,
  a different colour and a different shape from the green dot)

How it works — one environment flag, same code in both places:

- Server function `versionBadge()` in `server.js` reads `APP_VERSION`.
- `APP_VERSION=live` → LIVE badge. Anything else, including unset →
  MUSE — TEST / FIXING badge.
- The frontend defaults to the Muse text in the HTML itself, then
  replaces it from `/api/status` → `version.version`. If the API ever
  failed, the page would still show Muse, never LIVE by accident.
- `render.yaml` and `.env.example` set `APP_VERSION=live`, so the
  hosted deployment shows LIVE and cannot show the Muse badge.
- The Muse artifact edit (dispatched separately) applies the same
  rule in Muse: no `APP_VERSION=live` there, so it shows
  MUSE — TEST / FIXING and cannot show LIVE.

Tested both ways: `npm test` starts the server with no flag and
asserts `◆ MUSE — TEST / FIXING`, then starts it with
`APP_VERSION=live` and asserts `● LIVE` in `#16a34a`.

## What is preserved

Coordinator first-run password setup and login; create clients with
randomized 3-digit account numbers (100–999, never sequential, never
666 / 187 / 911, never any number containing those sequences; 897
usable numbers, then randomized 4-digit numbers with the same
exclusions); magic-link codes (7-day expiry, opens counted, revocable,
last-opened recorded); send panel showing recipient, account number,
exact email/phone, and the full message, with Send via email (mailto:)
and Send via text (sms:) prefilled to that client, plus Copy and
Mark sent; open client code entry on the first screen
("Clients — type your code here" + "Open my page"); client page
(portfolio, Step 0 niche agree/edit/override, Professional Default
hands-off confirmation, video submission, proof, monthly report,
release calendar); coordinator desk with searchable/sortable
All Clients, Previous/Next switching, SLA queue with a 3-day clock
from intake complete that pauses with reason/owner while blocked;
"Bridge connected" banner on the client record, badge in All Clients,
and timeline entry when a code is redeemed; Preview client side
without signing out of the desk, with Back to my desk.

The server never sends email or SMS itself, and a code is not a
clickable auto-login link: the client opens the public URL, then
types the code in. The send panel and the client message say that
plainly, in two steps: (1) share/open this app, (2) type the code.

## Stack

- Node.js ≥ 18, no framework. One optional dependency: `pg`, used
  only when `DATABASE_URL` is set.
- Frontend: one static page (`public/index.html`) served by the same server.
- Storage: Postgres when `DATABASE_URL` is set; otherwise `data.json`
  in the app directory (git-ignored, local testing only).

## Run and test locally

```
npm install
npm test    # starts its own servers, runs the full end-to-end test, twice-checked
npm start   # then open http://localhost:3000
```

`npm test` proves, on a fresh database: account-number pool 897,
banned numbers never issued, 4-digit fallback after exhaustion,
coordinator setup/login, two clients with unique account numbers,
mailto pre-addressed and sms present only with a phone on file,
code redemption → Bridge connected with last-opened time, portfolio
→ niche proposal → client agreement → video submission → schedule
(YouTube 12:00, TikTok 17:00, Instagram 18:00, Facebook 19:00)
→ proof/audit, and revoked codes refuse with "isn't active".

## Deploy — the one step that genuinely needs Michael

No public URL exists yet for this copy. A public URL cannot be
created from inside this workspace alone, because every free host
needs Michael's own account sign-in. This package is ready to deploy
in minutes once he does that one step:

**Exact step needed from Michael:** sign in (or create a free
account) on Render, create a Web Service from this folder/repo, set
`APP_VERSION=live`, and set `DATABASE_URL` to a free external
Postgres (Supabase or Neon free tier — create that free database
in the same step). `render.yaml` in this folder already encodes
the service, the free plan, and `APP_VERSION=live`.

Do NOT use Render's own free Postgres for live clients: it expires
30 days after creation and its data is then deleted. Do NOT rely on
`data.json` on a free host either: a free web service sleeps after
15 idle minutes and its local filesystem is lost on spin-down /
redeploy. With an external Postgres set, clients, codes, and the
shared record survive sleep and redeploy.

## Free-tier limits, plainly

- **Render (recommended for this Node server):** Hobby workspace
  $0/month; free web service 512 MB RAM, spins down after 15 idle
  minutes, ~30–60 seconds to wake on the next visit, 750 free
  instance hours per workspace per month, 5 GB outbound bandwidth,
  500 build minutes. A credit card is required to deploy a web
  service even on the free tier (verification hold, per secondary
  sources) — that is part of Michael's sign-in step above.
- **Replit:** NOT usable for free here — `create_app_from_prompt`
  failed with `requires_active_subscription`. Its Starter free
  publish also expires after 30 days and carries a badge, per
  secondary sources, so it is not a permanent free live link anyway.
- **Vercel:** not connected in this workspace (needs Michael's
  sign-in), and its free Hobby tier is for non-commercial use only
  — this app serves a paying client, so commercial use would need
  Pro ($20/user/month in secondary sources). Not chosen.
- **Supabase / Neon free Postgres (for DATABASE_URL):** free tiers
  are small (hundreds of MB) and free projects can pause after
  inactivity; they are adequate for a handful of clients, not for
  unlimited growth. Check the provider's current limits at sign-up.

## Why this is a copy, not a move — what was tried

1. `artifact.export` on `video-publishing-app`: refused — it is not
   a `web_static` artifact; "its behavior lives outside the page,
   so it cannot be exported to one .html file."
2. `artifact.share` on the same slug: refused — "Sharing
   server-backed artifacts is not enabled." A static rebuild would
   get a link but would lose saved entries, codes, and the shared
   record, so it is NOT acceptable as the live client version and
   was not done.
3. Replit (the only host already connected): creation failed with
   `requires_active_subscription`.
4. Vercel and GitHub connectors: not connected; both need Michael's
   sign-in, which this task must not work around by asking for
   passwords in chat.

Result: no second duplicate deployment was started, the Muse
original was not edited by this package (its badge edit is a
separate, dispatched artifact edit), and no public URL is claimed
in this README. The URL will exist only after Michael completes
the Render step above and the first deploy succeeds.
