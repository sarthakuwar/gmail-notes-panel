// Supabase Edge Function: Stripe billing for the $4/mo subscription.
//
// Checkout and the Billing Portal are both Stripe-hosted pages opened in a
// new browser tab (chrome.tabs.create) since Stripe Checkout can't run
// inside the extension's side panel iframe. This function also serves a
// tiny static confirmation page for those tabs to land on (GET /done) so
// we don't need a separate static host just for that.
//
// The webhook route (POST /webhook) is the only route Stripe itself calls;
// it has no Google bearer token, so it's routed before the token check and
// instead verifies the Stripe-Signature header.
import Stripe from "https://esm.sh/stripe@18?target=deno";
import { verifyGoogleToken, bearerToken } from "../_shared/google.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  httpClient: Stripe.createFetchHttpClient(),
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();

const STRIPE_PRICE_ID = Deno.env.get("STRIPE_PRICE_ID")!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const supabase = createClient(
  Deno.env.get("SB_URL")!,
  Deno.env.get("SB_SECRET_KEY")!,
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function html(body: string, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const DONE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Gmail Notes</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
         display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;
         background: #f8f9fa; color: #202124; text-align: center; }
  .card { max-width: 360px; padding: 32px; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { color: #5f6368; font-size: 14px; line-height: 1.5; }
</style></head>
<body><div class="card">
  <h1>You're all set</h1>
  <p>You can close this tab and go back to Gmail — the notes panel will unlock automatically in a few seconds.</p>
</div></body></html>`;

async function getSubscriptionRow(ownerEmail: string) {
  const { data } = await supabase
    .from("subscriptions")
    .select("owner_email, stripe_customer_id, stripe_subscription_id, status, current_period_end")
    .eq("owner_email", ownerEmail)
    .maybeSingle();
  return (
    data ?? {
      owner_email: ownerEmail,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      status: "none" as const,
      current_period_end: null,
    }
  );
}

function stripeStatusToOurs(status: Stripe.Subscription.Status) {
  // Stripe has a couple more granular statuses (incomplete, incomplete_expired,
  // paused) — fold those into "none"/"canceled" since we only distinguish
  // "has access" (trialing/active) from everything else.
  if (status === "trialing" || status === "active" || status === "past_due" || status === "unpaid") return status;
  return "canceled" as const;
}

async function syncSubscriptionFromStripe(subscription: Stripe.Subscription, ownerEmail?: string) {
  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;

  let owner = ownerEmail;
  if (!owner) {
    const customer = await stripe.customers.retrieve(customerId);
    owner = !("deleted" in customer && customer.deleted) ? (customer as Stripe.Customer).metadata?.owner_email : undefined;
  }
  if (!owner) return; // no way to trace this event back to an owner — nothing to do

  const item = subscription.items.data[0];
  const { error } = await supabase.from("subscriptions").upsert(
    {
      owner_email: owner,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscription.id,
      status: stripeStatusToOurs(subscription.status),
      current_period_end: item?.current_period_end
        ? new Date(item.current_period_end * 1000).toISOString()
        : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "owner_email" },
  );
  if (error) console.error("subscription upsert failed", error.message);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname.endsWith("/done")) {
    return html(DONE_PAGE);
  }

  // --- Stripe calls this directly; verify by signature, not a Google token. ---
  if (req.method === "POST" && url.pathname.endsWith("/webhook")) {
    const signature = req.headers.get("Stripe-Signature");
    const body = await req.text();
    if (!signature) return json({ error: "missing signature" }, 400);

    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(body, signature, STRIPE_WEBHOOK_SECRET, undefined, cryptoProvider);
    } catch (err) {
      return json({ error: `signature verification failed: ${(err as Error).message}` }, 400);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          if (session.mode === "subscription" && session.subscription) {
            const subscriptionId =
              typeof session.subscription === "string" ? session.subscription : session.subscription.id;
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            await syncSubscriptionFromStripe(subscription, session.metadata?.owner_email ?? undefined);
          }
          break;
        }
        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
          const subscription = event.data.object as Stripe.Subscription;
          await syncSubscriptionFromStripe(subscription);
          break;
        }
      }
    } catch (err) {
      console.error("webhook handling error", err);
      return json({ error: "handler failed" }, 500);
    }

    return json({ received: true });
  }

  // --- Everything below requires a verified Google identity. ---
  const token = bearerToken(req);
  if (!token) return json({ error: "missing bearer token" }, 401);

  let ownerEmail: string;
  try {
    ownerEmail = await verifyGoogleToken(token);
  } catch (err) {
    return json({ error: (err as Error).message }, 401);
  }

  if (req.method === "GET" && url.pathname.endsWith("/status")) {
    const row = await getSubscriptionRow(ownerEmail);
    return json(row);
  }

  if (req.method === "POST" && url.pathname.endsWith("/checkout")) {
    const doneUrl = `${url.origin}${url.pathname.replace(/\/checkout$/, "/done")}`;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      subscription_data: { trial_period_days: 7 },
      customer_email: ownerEmail,
      metadata: { owner_email: ownerEmail },
      success_url: doneUrl,
      cancel_url: doneUrl,
    });
    return json({ url: session.url });
  }

  if (req.method === "POST" && url.pathname.endsWith("/portal")) {
    const row = await getSubscriptionRow(ownerEmail);
    if (!row.stripe_customer_id) return json({ error: "no subscription on file" }, 404);
    const doneUrl = `${url.origin}${url.pathname.replace(/\/portal$/, "/done")}`;
    const session = await stripe.billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url: doneUrl,
    });
    return json({ url: session.url });
  }

  return json({ error: "not found" }, 404);
});
