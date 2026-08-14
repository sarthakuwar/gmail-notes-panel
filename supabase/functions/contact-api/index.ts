// Supabase Edge Function: the main thing the extension talks to for notes.
//
// Two concerns live here:
//  - Auth token brokering (/auth/exchange, /auth/refresh): the extension
//    uses Google's OAuth *authorization code* flow so it can get a refresh
//    token and stay signed in silently across browser restarts. Google's
//    token endpoint requires the OAuth client's secret for both the code
//    exchange and refresh grants, so that step has to happen server-side —
//    the secret must never ship inside the extension.
//  - Contact notes (GET/POST "/", GET "/list"): the extension sends the
//    Google access token it got above on every request. We verify that
//    token against Google's own tokeninfo endpoint on every call (see
//    _shared/google.ts), use the verified email as the owner, gate on an
//    active subscription/trial (_shared/subscription.ts), and read/write
//    the `contacts` table with the service-role key. The extension never
//    talks to Postgres directly.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyGoogleToken, bearerToken } from "../_shared/google.ts";
import { hasAccess, getSubscription } from "../_shared/subscription.ts";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

// Explicit custom secrets (SB_URL / SB_SECRET_KEY) rather than the
// reserved SUPABASE_* names — this project uses the new publishable/secret
// API key format, and setting these ourselves avoids any ambiguity about
// what the auto-injected reserved vars resolve to.
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

function maxDate(a?: string | null, b?: string | null): string | null {
  if (!a) return b ?? null;
  if (!b) return a ?? null;
  return a > b ? a : b;
}

async function exchangeWithGoogle(params: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      ...params,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error_description || data.error || "Google token exchange failed");
  }
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);

  // --- Auth token brokering: no Google bearer token yet at this point,
  // that's the whole point of these two routes. ---
  if (req.method === "POST" && url.pathname.endsWith("/auth/exchange")) {
    const body = await req.json().catch(() => ({}));
    if (!body.code || !body.redirect_uri) {
      return json({ error: "code and redirect_uri are required" }, 400);
    }
    try {
      const data = await exchangeWithGoogle({
        code: body.code,
        redirect_uri: body.redirect_uri,
        grant_type: "authorization_code",
      });
      return json({
        access_token: data.access_token,
        refresh_token: data.refresh_token ?? null,
        expires_in: data.expires_in,
      });
    } catch (err) {
      return json({ error: (err as Error).message }, 401);
    }
  }

  if (req.method === "POST" && url.pathname.endsWith("/auth/refresh")) {
    const body = await req.json().catch(() => ({}));
    if (!body.refresh_token) return json({ error: "refresh_token is required" }, 400);
    try {
      const data = await exchangeWithGoogle({
        refresh_token: body.refresh_token,
        grant_type: "refresh_token",
      });
      return json({ access_token: data.access_token, expires_in: data.expires_in });
    } catch (err) {
      return json({ error: (err as Error).message }, 401);
    }
  }

  // --- Everything below requires a verified Google identity + an active
  // subscription/trial. ---
  const token = bearerToken(req);
  if (!token) return json({ error: "missing bearer token" }, 401);

  let ownerEmail: string;
  try {
    ownerEmail = await verifyGoogleToken(token);
  } catch (err) {
    return json({ error: (err as Error).message }, 401);
  }

  if (!(await hasAccess(ownerEmail))) {
    const sub = await getSubscription(ownerEmail);
    return json({ error: "subscription_required", status: sub.status }, 402);
  }

  if (req.method === "GET" && url.pathname.endsWith("/list")) {
    const { data, error } = await supabase
      .from("contacts")
      .select("contact_email, contact_name, note, tags, last_contacted, remind_at")
      .eq("owner_email", ownerEmail)
      .order("last_contacted", { ascending: false, nullsFirst: false })
      .limit(1000);

    if (error) return json({ error: error.message }, 500);
    return json({ contacts: data ?? [] });
  }

  if (req.method === "GET") {
    const contactEmail = url.searchParams.get("contact_email")?.toLowerCase();
    if (!contactEmail) return json({ error: "contact_email is required" }, 400);

    const { data, error } = await supabase
      .from("contacts")
      .select("contact_email, contact_name, note, tags, last_contacted, remind_at")
      .eq("owner_email", ownerEmail)
      .eq("contact_email", contactEmail)
      .maybeSingle();

    if (error) return json({ error: error.message }, 500);
    return json(
      data ?? {
        contact_email: contactEmail,
        contact_name: null,
        note: "",
        tags: [],
        last_contacted: null,
        remind_at: null,
      },
    );
  }

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const contactEmail = typeof body.contact_email === "string" ? body.contact_email.toLowerCase() : null;
    if (!contactEmail) return json({ error: "contact_email is required" }, 400);

    const { data: existing } = await supabase
      .from("contacts")
      .select("contact_name, note, tags, last_contacted, remind_at")
      .eq("owner_email", ownerEmail)
      .eq("contact_email", contactEmail)
      .maybeSingle();

    const row = {
      owner_email: ownerEmail,
      contact_email: contactEmail,
      contact_name: body.contact_name ?? existing?.contact_name ?? null,
      note: body.note !== undefined ? body.note : existing?.note ?? "",
      tags: body.tags !== undefined ? body.tags : existing?.tags ?? [],
      last_contacted: maxDate(existing?.last_contacted, body.observed_last_message_at),
      remind_at: body.remind_at !== undefined ? body.remind_at : existing?.remind_at ?? null,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase.from("contacts").upsert(row, { onConflict: "owner_email,contact_email" });
    if (error) return json({ error: error.message }, 500);

    const { owner_email: _omit, ...result } = row;
    return json(result);
  }

  return json({ error: "method not allowed" }, 405);
});
