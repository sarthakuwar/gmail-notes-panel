// Supabase Edge Function: Polar billing for the $4.99/mo subscription.
//
// Polar is a merchant of record (like Paddle/Lemon Squeezy) rather than a
// direct payment processor — it handles global tax compliance and, unlike
// Stripe, doesn't require the seller to be an invite-only-approved
// registered business in every country. Talks to Polar's REST API with
// plain fetch() (no SDK) so this stays dependency-free and easy to audit,
// same as the Google token handling in contact-api.
//
// Checkout and the Customer Portal are both Polar-hosted pages opened in a
// new browser tab (chrome.tabs.create) since neither can run inside the
// extension's side panel iframe. This function also serves a tiny static
// confirmation page for those tabs to land on (GET /done).
//
// The webhook route (POST /webhook) is the only route Polar itself calls;
// it has no Google bearer token, so it's routed before the token check and
// instead verifies the Standard Webhooks signature Polar signs events with.
import { verifyGoogleToken, bearerToken } from "../_shared/google.ts";
import { getSubscription } from "../_shared/subscription.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// "sandbox" while testing, "production" once actually charging people —
// see README "Going live". Everything else (token, product, webhook
// secret) is environment-specific too and must be swapped together.
const POLAR_ENVIRONMENT = Deno.env.get("POLAR_ENVIRONMENT") ?? "sandbox";
const POLAR_API_BASE =
  POLAR_ENVIRONMENT === "production" ? "https://api.polar.sh/v1" : "https://sandbox-api.polar.sh/v1";

const POLAR_ACCESS_TOKEN = Deno.env.get("POLAR_ACCESS_TOKEN")!;
const POLAR_PRODUCT_ID = Deno.env.get("POLAR_PRODUCT_ID")!;
const POLAR_WEBHOOK_SECRET = Deno.env.get("POLAR_WEBHOOK_SECRET")!;

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

async function polarFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${POLAR_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${POLAR_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail ? JSON.stringify(data.detail) : `Polar API error: ${res.status}`);
  return data;
}

// Signature verification for Polar's webhooks. Docs point at the Standard
// Webhooks spec (https://www.standardwebhooks.com/), but Polar's actual
// implementation diverges from that spec's usual "strip whsec_, base64-decode
// the rest" key handling: empirically (verified against a real captured
// payload + signature via the /v1/webhooks/deliveries API), the HMAC key is
// the full secret string, "whsec_" prefix included, taken as raw UTF-8 bytes
// — not base64-decoded at all. Headers: webhook-id, webhook-timestamp,
// webhook-signature ("v1,<base64 sig>", space-delimited for key rotation).
// Signed content is "{id}.{timestamp}.{raw body}".
async function verifyPolarSignature(rawBody: string, headers: Headers): Promise<void> {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatureHeader = headers.get("webhook-signature");
  if (!id || !timestamp || !signatureHeader) throw new Error("missing webhook signature headers");

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 5 * 60) throw new Error("webhook timestamp outside tolerance");

  const secretBytes = new TextEncoder().encode(POLAR_WEBHOOK_SECRET);
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const macBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent)));
  const expected = base64Encode(macBytes);

  const provided = signatureHeader
    .split(" ")
    .map((part) => part.split(",")[1])
    .filter(Boolean);
  if (!provided.some((sig) => timingSafeEqual(sig, expected))) throw new Error("signature mismatch");
}

function base64Encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type OurStatus = "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "none";

function polarStatusToOurs(status: string): OurStatus {
  // Polar also has "incomplete"/"incomplete_expired"/"paused" — fold those
  // into "none" since we only distinguish "has access" from everything else.
  if (status === "trialing" || status === "active" || status === "past_due" || status === "unpaid") {
    return status;
  }
  return "none";
}

async function syncSubscriptionFromPolar(subscription: Record<string, any>) {
  const ownerEmail = subscription.customer?.external_id;
  if (!ownerEmail) return; // no way to trace this event back to an owner — nothing to do

  const { error } = await supabase.from("subscriptions").upsert(
    {
      owner_email: ownerEmail,
      billing_customer_id: subscription.customer_id,
      billing_subscription_id: subscription.id,
      status: polarStatusToOurs(subscription.status),
      current_period_end: subscription.current_period_end ?? null,
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

  // --- Polar calls this directly; verify by signature, not a Google token. ---
  if (req.method === "POST" && url.pathname.endsWith("/webhook")) {
    const rawBody = await req.text();
    try {
      await verifyPolarSignature(rawBody, req.headers);
    } catch (err) {
      return json({ error: `signature verification failed: ${(err as Error).message}` }, 400);
    }

    const event = JSON.parse(rawBody);
    try {
      if (event.type === "subscription.created" || event.type === "subscription.updated") {
        await syncSubscriptionFromPolar(event.data);
      } else if (event.type === "subscription.revoked") {
        await syncSubscriptionFromPolar({ ...event.data, status: "canceled" });
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
    const row = await getSubscription(ownerEmail);
    return json(row);
  }

  if (req.method === "POST" && url.pathname.endsWith("/checkout")) {
    const doneUrl = `${url.origin}${url.pathname.replace(/\/checkout$/, "/done")}`;
    try {
      const session = await polarFetch("/checkouts", {
        method: "POST",
        body: JSON.stringify({
          products: [POLAR_PRODUCT_ID],
          customer_email: ownerEmail,
          external_customer_id: ownerEmail,
          trial_interval: "day",
          trial_interval_count: 7,
          success_url: doneUrl,
        }),
      });
      return json({ url: session.url });
    } catch (err) {
      return json({ error: (err as Error).message }, 502);
    }
  }

  if (req.method === "POST" && url.pathname.endsWith("/portal")) {
    try {
      const session = await polarFetch("/customer-sessions", {
        method: "POST",
        body: JSON.stringify({ external_customer_id: ownerEmail }),
      });
      return json({ url: session.customer_portal_url });
    } catch (err) {
      console.error("portal session creation failed", (err as Error).message);
      return json({ error: (err as Error).message }, 404);
    }
  }

  return json({ error: "not found" }, 404);
});
