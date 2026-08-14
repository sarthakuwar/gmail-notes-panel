// Shared by contact-api and billing-api: verifies a Google OAuth access
// token against Google's own tokeninfo endpoint on every call (confirming
// both validity and that it was issued for *this* app's OAuth client), and
// returns the verified email as the caller's identity.
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;

export async function verifyGoogleToken(token: string): Promise<string> {
  const res = await fetch(
    `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(token)}`,
  );
  if (!res.ok) throw new Error("Invalid or expired token");
  const info = await res.json();
  if (info.aud !== GOOGLE_CLIENT_ID) throw new Error("Token was not issued for this app");
  if (!info.email || info.email_verified !== "true") throw new Error("Email not verified");
  return info.email.toLowerCase();
}

export function bearerToken(req: Request): string | null {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  return token || null;
}
