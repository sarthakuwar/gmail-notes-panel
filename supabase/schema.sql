create extension if not exists pgcrypto;

create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null,
  contact_email text not null,
  contact_name text,
  note text not null default '',
  tags text[] not null default '{}',
  last_contacted timestamptz,
  remind_at date,
  updated_at timestamptz not null default now(),
  unique (owner_email, contact_email)
);

create index if not exists contacts_owner_idx on contacts (owner_email);

-- Added after the initial launch: follow-up reminder date, nullable.
alter table contacts add column if not exists remind_at date;

-- RLS is enabled with no policies on purpose: all access goes through the
-- contact-api edge function, which uses the service-role key and verifies
-- the caller's identity itself (see supabase/functions/contact-api). No
-- client ever talks to this table directly.
alter table contacts enable row level security;

-- Mirrors Stripe's own subscription status per owner — kept in sync by the
-- billing-api webhook handler. Deliberately no independent trial-clock
-- logic here: Stripe's Billing APIs own the trial/renewal state machine
-- (see subscription_data.trial_period_days in billing-api), this table
-- just caches the latest status so contact-api can gate access without an
-- API call to Stripe on every request.
create table if not exists subscriptions (
  owner_email text primary key,
  stripe_customer_id text,
  stripe_subscription_id text,
  status text not null default 'none', -- trialing | active | past_due | canceled | unpaid | none
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists subscriptions_customer_idx on subscriptions (stripe_customer_id);

-- Same pattern as contacts: no client-side access, only the edge functions
-- (contact-api reads it, billing-api writes it) using the service-role key.
alter table subscriptions enable row level security;
