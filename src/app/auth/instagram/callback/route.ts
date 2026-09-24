import "server-only";

import { NextResponse } from "next/server";

import { resolvePublicOrigin } from "@/lib/http/public-origin";
import { toSafeInstagramOAuthDiagnostics } from "@/lib/social/instagram-adapter";
import { connectRealInstagramAccount } from "@/server/services/social-accounts";
import { getWorkspaceBySlug } from "@/server/services/workspaces";

/**
 * MVP-5.22 — real Instagram account connection callback. Supersedes the
 * MVP-5.16/5.18 evidence-capture version of this route: that phase is
 * complete (evidence preserved in evidence/instagram/*.json, gitignored),
 * and this is the same, already-registered Meta redirect URI evolved into
 * its real production form, per the task's own instruction not to invent a
 * second OAuth callback path or re-register a new redirect_uri.
 *
 * This route creates exactly one thing: a connected `social_accounts` row
 * (via the existing connectSocialAccount architecture, MVP-2.1/5.22) for
 * the workspace that initiated the connection. It performs no media
 * discovery, no Insights fetch, no metric sync, and no persistence beyond
 * that single row — those are explicitly out of this milestone's scope.
 *
 * Workspace context travels through the standard OAuth `state` parameter
 * (the workspace slug, set by /auth/instagram/start) — a normal top-level
 * browser redirect carries the user's own Supabase session cookies back to
 * this route, so the existing RLS-scoped `assertEditor` check inside
 * connectSocialAccount (unchanged) is what actually authorizes the write;
 * `state` only tells this route *which* workspace to check that against.
 *
 * Never returns the access token, client secret, or authorization code —
 * connectRealInstagramAccount's only outputs are the persisted
 * SocialAccount row, which itself never contains a raw credential
 * (Vault holds it; the row holds only an opaque vault_secret_id), and the
 * granted permission names (MVP-5.34I).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const error = searchParams.get("error");
  const errorReason = searchParams.get("error_reason");
  const errorDescription = searchParams.get("error_description");
  const code = searchParams.get("code");
  const workspaceSlug = searchParams.get("state");

  if (error) {
    return NextResponse.json({ status: "error", stage: "authorization", error, errorReason, errorDescription }, { status: 400 });
  }
  if (!code) {
    return NextResponse.json(
      { status: "error", stage: "authorization", error: "missing_code", message: "No authorization code was present on the callback request." },
      { status: 400 },
    );
  }
  if (!workspaceSlug) {
    return NextResponse.json(
      { status: "error", stage: "authorization", error: "missing_workspace_context", message: "No workspace context (state) was present on the callback request." },
      { status: 400 },
    );
  }

  const workspace = await getWorkspaceBySlug(workspaceSlug).catch(() => null);
  if (!workspace) {
    return NextResponse.json({ status: "error", stage: "authorization", error: "unknown_workspace" }, { status: 400 });
  }

  const redirectUri = `${resolvePublicOrigin(request)}/auth/instagram/callback`;

  try {
    const { account, grantedPermissions } = await connectRealInstagramAccount(workspace.id, { code, redirectUri });
    return NextResponse.json({
      status: "connected",
      platform: account.platform,
      socialAccountId: account.id,
      externalAccountId: account.external_account_id,
      workspaceSlug,
      // MVP-5.34I: scope names only (safeGrantedPermissionNames-filtered) — the deterministic grant evidence.
      grantedPermissions,
    });
  } catch (err) {
    // MVP-5.34A: allowlisted fields only (providerStage, Meta code/subcode,
    // fbtrace_id) — never providerResponse, the code, a token, or a secret.
    const diagnostics = toSafeInstagramOAuthDiagnostics(err, [code, process.env.INSTAGRAM_CLIENT_SECRET ?? ""]);
    console.error("[instagram-oauth] connection failed", diagnostics);
    return NextResponse.json({ status: "error", ...diagnostics }, { status: 502 });
  }
}
