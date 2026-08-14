# Chrome Web Store listing content

Copy-paste source for the Developer Dashboard fields. Privacy policy is
live at https://sarthakuwar.github.io/gmail-notes-panel/privacy.html.

## Basic info

- **Extension name:** Gmail Notes
- **Category:** Productivity
- **Language:** English

## Short description (132 char max)

Notes, tags, and follow-up reminders for whoever's email thread is open in Gmail. $3.99/mo, 7-day free trial.

## Detailed description

```
Gmail Notes puts a lightweight CRM-lite panel right next to your inbox —
no pipelines, no deal stages, just notes keyed by whoever you're emailing.

• Open any thread in Gmail and the side panel shows notes, tags, and the
  last-contacted date for that person automatically.
• Tag contacts (lead, referral, follow-up — whatever fits) and filter your
  whole contact list by tag.
• Set a follow-up reminder date on anyone; a small badge shows who's due.
• Search across all your notes from one place — no more digging through
  old threads to remember what you talked about.

Sign in with Google — the same account you use for Gmail, no separate
signup. 7 days free, then $3.99/month. Cancel anytime.

Gmail Notes only reads the sender name/email and timestamp of the thread
you have open — never message bodies or attachments. Full privacy policy:
https://sarthakuwar.github.io/gmail-notes-panel/privacy.html
```

## Single purpose statement

Gmail Notes shows and edits a private note, tags, and a follow-up reminder
for the person whose email thread is currently open in Gmail.

## Permission justifications

- **`identity`** — used to sign the user in with their Google account
  (`chrome.identity.launchWebAuthFlow`) so notes can be tied to their
  identity without a separate account system.
- **`sidePanel`** — the extension's entire UI lives in Chrome's side panel.
- **`storage`** — caches the signed-in user's own email address locally
  (to tell "me" apart from "the contact" in a thread) and the OAuth
  refresh token (so sign-in persists across browser restarts).
- **`host_permissions: mail.google.com`** — the content script reads the
  sender/timestamp of the open thread from the page DOM; this is the
  extension's core function.
- **`host_permissions: www.googleapis.com`** — calls Google's OAuth
  tokeninfo/userinfo endpoints to sign the user in and verify their token.
- **`host_permissions: <supabase-project>.supabase.co`** — the only
  backend the extension talks to, for reading/writing notes and billing
  status.

## Data use disclosure (CWS "Privacy practices" tab)

- Collects: **Personal communications** (contact email/name from the open
  thread only — not message content), **User activity** (notes/tags you
  write), **Website content** is NOT collected (no message bodies read).
- Purpose: **App functionality** — not sold, not used for advertising, not
  used for purposes unrelated to the extension's single purpose above.
- Privacy policy URL: `https://sarthakuwar.github.io/gmail-notes-panel/privacy.html`

## Screenshots

Chrome Web Store requires at least one 1280×800 (or 640×400) screenshot.
Suggested shots, captured from the loaded extension in Chrome:
1. Side panel open next to a Gmail thread, showing a filled-in note.
2. The "All contacts" list view with tags/search.
3. The paywall/trial screen.

## Still needed from you before submitting

- A Chrome Web Store developer account (one-time $5 fee):
  https://chrome.google.com/webstore/devconsole
- The screenshots above (I can't capture real Chrome Web Store screenshots
  without the extension already loaded in your browser).
- Swap Polar to production credentials when ready to actually charge (see
  README's "Going live" section) — do this deliberately, not by default.
