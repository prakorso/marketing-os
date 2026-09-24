import "server-only";

import { NextResponse } from "next/server";

import { resolvePublicOrigin } from "@/lib/http/public-origin";

/**
 * MVP-5.16, extended MVP-5.22 — Instagram OAuth entry point, paired with
 * src/app/auth/instagram/callback/route.ts (now the real account-connection
 * callback). Requires `?workspace=<slug>` — the workspace the connection
 * should be associated with — and carries it through Meta's standard
 * `state` parameter so the callback knows which workspace to check
 * authorization against once the browser is redirected back.
 *
 * Not itself a business-logic endpoint: no token handling, no persistence
 * — a single redirect, built from Meta's documented "Instagram API with
 * Instagram Login" authorization endpoint
 * (https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login).
 */
export async function GET(request: Request) {
  const clientId = process.env.INSTAGRAM_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ stage: "configuration", status: "error", error: "missing_credentials" }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const workspaceSlug = searchParams.get("workspace");
  if (!workspaceSlug) {
    return NextResponse.json(
      { stage: "configuration", status: "error", error: "missing_workspace", message: "A ?workspace=<slug> query parameter is required to start an Instagram connection." },
      { status: 400 },
    );
  }

  const redirectUri = `${resolvePublicOrigin(request)}/auth/instagram/callback`;

  const authorizeUrl = new URL("https://www.instagram.com/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  // instagram_business_basic: MVP-5.13-verified minimum for account/media
  // access; instagram_business_manage_insights: required for the
  // /insights endpoint the metrics-sync path (MVP-5.19/5.20) depends on.
  authorizeUrl.searchParams.set("scope", "instagram_business_basic,instagram_business_manage_insights");
  authorizeUrl.searchParams.set("state", workspaceSlug);

  return NextResponse.redirect(authorizeUrl.toString());
}
