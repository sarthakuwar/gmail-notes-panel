// Shared by contact-api (reads, to gate access) and billing-api (writes,
// from the Stripe webhook). This table is a thin cache of Stripe's own
// subscription status — see supabase/schema.sql for why there's no
// independent trial/renewal clock here.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SB_URL")!,
  Deno.env.get("SB_SECRET_KEY")!,
);

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "none";

export interface SubscriptionRow {
  owner_email: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: SubscriptionStatus;
  current_period_end: string | null;
}

export async function getSubscription(ownerEmail: string): Promise<SubscriptionRow> {
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
      status: "none",
      current_period_end: null,
    }
  );
}

export async function hasAccess(ownerEmail: string): Promise<boolean> {
  const { status } = await getSubscription(ownerEmail);
  return status === "trialing" || status === "active";
}
