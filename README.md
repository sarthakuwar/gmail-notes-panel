# Noterra

A Chrome side panel that shows notes, tags, and follow-up reminders for
whoever's email thread you have open in Gmail. No pipelines, no deal
stages — just notes keyed by email address. $3.99/month after a 7-day free
trial.

```
extension/   Chrome extension (Manifest V3)
supabase/    Postgres schema + edge function backend
docs/        Privacy policy / terms, served via GitHub Pages
```

## How it works

- `content.js` watches the open Gmail thread and extracts the other
  participant's email/name from Gmail's DOM (`span.gD`), plus the most
  recent message timestamp.
- `background.js` tracks which tab is focused and brokers Google OAuth
  tokens via `chrome.identity`, using the authorization-code flow so it
  can hold a refresh token and stay signed in silently across browser
  restarts (see "Auth model" below).
- `sidepanel.js` shows the note editor, the searchable all-contacts list,
  and the billing/paywall screens, talking to two Supabase Edge Functions.
- `contact-api` verifies the extension's Google access token against
  Google's `tokeninfo` endpoint on every call, uses the verified email as
  the owner, checks there's an active trial/subscription, and reads/writes
  the `contacts` table with the service-role key.
- `billing-api` creates [Polar](https://polar.sh) Checkout/Customer-Portal
  sessions and handles the Polar webhook that keeps the `subscriptions`
  table in sync. Polar is a merchant of record — it handles global tax
  compliance and, unlike Stripe, doesn't require the seller to be an
  invite-only-approved registered business in every country (Stripe is
  invite-only in India for individuals, which is why this isn't Stripe).
- The extension never talks to Postgres or Polar directly — everything
  goes through those two edge functions.

## Auth model (why sign-in doesn't nag you anymore)

Earlier versions used OAuth's implicit flow and cached the access token
only in memory, so every browser restart (and every ~hour of use, once the
token expired) forced a fresh interactive sign-in. This version uses the
**authorization code flow**: the first sign-in is still an interactive
Google popup, but it also returns a refresh token, exchanged and stored
via `contact-api`'s `/auth/exchange` route and kept in
`chrome.storage.local` (persists across restarts). After that,
`background.js` silently mints new access tokens via `/auth/refresh` —
no popup — until you explicitly sign out.

## Setup status (this project)

Project: `ngtdhqqlgrzlioenztgp` (Supabase). Already done:

- [x] Schema applied (`contacts`, `subscriptions` tables) — via Supabase MCP.
- [x] `contact-api` and `billing-api` (Polar) edge functions written.
- [x] Google OAuth secrets set, both edge functions deployed and smoke-tested.
- [x] Extension icons/manifest, GitHub Pages for privacy/terms.
- [ ] Polar sandbox product + webhook + access token — needs your Polar
      account (see below), since there's no CLI/API shortcut for this the
      way there was with Stripe.

### Setting up Polar (sandbox first, same pattern as everything else here)

1. Sign up at https://polar.sh and create an organization — or go straight
   to https://sandbox.polar.sh (sandbox is a fully separate environment
   from production; test payments there before ever touching real money).
2. Create a product: name "Noterra Pro", recurring monthly price
   **$3.99 USD**. Copy the **Product ID**.
3. Organization settings → create an **Organization Access Token**. Copy it.
4. Organization settings → Webhooks → *Add Endpoint* → URL
   `https://ngtdhqqlgrzlioenztgp.supabase.co/functions/v1/billing-api/webhook`,
   format `raw`, events: `subscription.created`, `subscription.updated`,
   `subscription.revoked`. Copy the generated secret (`whsec_...`).
5. Add to `supabase/.env.local` (gitignored):
   ```
   POLAR_ENVIRONMENT=sandbox
   POLAR_ACCESS_TOKEN=<org access token>
   POLAR_PRODUCT_ID=<product id>
   POLAR_WEBHOOK_SECRET=<whsec_...>
   ```
6. Set secrets and redeploy (same command used for every secret in this
   project — `SUPABASE_ACCESS_TOKEN` is your own personal access token
   from https://supabase.com/dashboard/account/tokens, needed because the
   Supabase MCP server has no secrets-management tool):
   ```
   SUPABASE_ACCESS_TOKEN=<token> npx -y supabase@latest secrets set \
     --project-ref ngtdhqqlgrzlioenztgp --env-file supabase/.env.local
   ```
   Then redeploy `billing-api` so it picks up the new secrets on a fresh
   cold start.

### Load the extension and test

1. Go to `chrome://extensions`, enable Developer mode.
2. "Load unpacked" → select the `extension/` folder. Note the Extension ID
   shown on the card.
3. Auth uses `chrome.identity.launchWebAuthFlow`, not `getAuthToken` — this
   works whether or not "Allow Chrome sign-in" is enabled in the browser,
   at the cost of needing a **Web application**-type OAuth client (not
   "Chrome Extension" type):
   - Google Cloud Console → Credentials → Create Credentials → OAuth
     client ID → Application type **Web application**.
   - Authorized redirect URI: `https://<EXTENSION_ID>.chromiumapp.org/`
     (the exact value `chrome.identity.getRedirectURL()` returns for this
     extension — the ID from step 2, trailing slash included).
   - Put the resulting client ID in `extension/config.js`
     (`GOOGLE_CLIENT_ID`); the client secret goes only in the Supabase
     secret above, never in the extension.
4. Reload the extension in `chrome://extensions`, open Gmail, click the
   toolbar icon, and click "Sign in with Google". First sign-in you'll
   also see the 7-day-trial paywall screen — that's expected, it's gated
   by Polar Checkout (sandbox mode; use test card `4242 4242 4242 4242`,
   any future expiry/CVC).

## Chrome Web Store submission

See `STORE_LISTING.md` for the actual listing copy and permission
justifications. Steps:

1. ~~Enable GitHub Pages~~ — done: https://sarthakuwar.github.io/noterra/
   (privacy policy: `/privacy.html`, terms: `/terms.html`).
2. Package the extension: `dist/noterra.zip` (manifest at the zip's
   root, exactly what the Dashboard expects — rebuild it any time by
   staging `extension/`'s files, minus `icons/gen_icons.py`, into a temp
   folder and zipping that).
3. Create a one-time Chrome Web Store developer account ($5 fee):
   https://chrome.google.com/webstore/devconsole
4. Upload the zip, paste in `STORE_LISTING.md`'s content, add the privacy
   policy URL, add screenshots, submit for review.

## Going live (real money)

Everything above runs on Polar's **sandbox** environment — no real
charges. Before launching for real:

1. In the Polar dashboard (production, not sandbox — https://polar.sh, not
   sandbox.polar.sh), re-create the product/price there (sandbox objects
   don't carry over) at **$3.99/month**.
2. Create a production **Organization Access Token** and a production
   webhook endpoint (same URL/events as sandbox).
3. Update `POLAR_ENVIRONMENT=production`, `POLAR_ACCESS_TOKEN`,
   `POLAR_PRODUCT_ID`, `POLAR_WEBHOOK_SECRET` Supabase secrets with the
   production values, redeploy `billing-api`.

Do this deliberately, when you're actually ready to charge people — not as
part of routine deploys.

## Known limitations / next steps

- **Gmail DOM selectors** (`span.gD`, `span.g3`) are undocumented and can
  change with Gmail redesigns — this is the one thing most likely to need
  a fix later.
- **Follow-up reminders are passive** — a badge shows in the panel when
  one's due, but there's no proactive notification (would need the
  `notifications`/`alarms` permissions, deliberately left out for now to
  keep the permission footprint small for store review).
- Group threads: the panel picks the most recently seen non-self sender
  as "the contact." Fine for 1:1 threads; group threads with several
  external participants will only track one.
