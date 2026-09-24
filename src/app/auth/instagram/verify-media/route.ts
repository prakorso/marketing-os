import "server-only";

import { NextResponse } from "next/server";

import { resolveNormalizer } from "@/lib/analytics/normalizer-registry";
import { REAL_CREDENTIAL_METADATA_KEY, REAL_CREDENTIAL_METADATA_VALUE, resolveProviderAdapter } from "@/lib/social/registry";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getCurrentUserRole, getWorkspaceBySlug } from "@/server/services/workspaces";

/**
 * MVP-5.23 Phase 7 — real-evidence verification tool, NOT a production
 * endpoint. Calls InstagramProviderAdapter.getMetrics() + the registered
 * InstagramNormalizer directly against one real, already-known Instagram
 * media id, for the account connected in MVP-5.22, and returns only the
 * normalized (canonical) result — never the raw provider payload, never
 * any credential.
 *
 * Exists only because MVP-5.23's own audit found that the current
 * publications lifecycle trigger makes it impossible for any publication
 * to reach status='published' with a real Instagram external_publication_id
 * today (see docs/DECISIONS.md-pending MVP-5.23 checkpoint — content
 * linkage is deferred to a follow-up milestone). This route proves the
 * adapter -> normalizer segment works against real data without going
 * through (or faking) that missing linkage, and performs no database
 * write of any kind.
 *
 * ?workspace=<slug>&mediaId=<real Instagram media id>
 * Requires the caller to be signed in as at least a viewer of that
 * workspace (RLS-scoped session, same as every other authenticated route)
 * and for that workspace to already have a real-tagged
 * (metadata.credentialKind === "real") connected Instagram social account.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceSlug = searchParams.get("workspace");
  const mediaId = searchParams.get("mediaId");

  if (!workspaceSlug || !mediaId) {
    return NextResponse.json(
      { status: "error", error: "missing_params", message: "Both ?workspace=<slug> and ?mediaId=<id> are required." },
      { status: 400 },
    );
  }

  const workspace = await getWorkspaceBySlug(workspaceSlug).catch(() => null);
  if (!workspace) {
    return NextResponse.json({ status: "error", error: "unknown_workspace" }, { status: 400 });
  }

  const role = await getCurrentUserRole(workspace.id);
  if (!role) {
    return NextResponse.json({ status: "error", error: "not_a_member" }, { status: 403 });
  }

  const supabase = await createClient();
  const { data: socialAccount, error: accountError } = await supabase
    .from("social_accounts")
    .select("*")
    .eq("workspace_id", workspace.id)
    .eq("platform", "instagram")
    .maybeSingle();
  if (accountError) {
    return NextResponse.json({ status: "error", error: "account_lookup_failed", message: accountError.message }, { status: 500 });
  }
  if (!socialAccount || (socialAccount.metadata as Record<string, unknown> | null)?.[REAL_CREDENTIAL_METADATA_KEY] !== REAL_CREDENTIAL_METADATA_VALUE) {
    return NextResponse.json({ status: "error", error: "no_real_instagram_account_connected" }, { status: 400 });
  }
  if (!socialAccount.vault_secret_id) {
    return NextResponse.json({ status: "error", error: "no_stored_credential" }, { status: 400 });
  }

  const vault = createServiceRoleClient();
  const { data: credential, error: credentialError } = await vault.rpc("read_social_account_vault_secret", {
    p_secret_id: socialAccount.vault_secret_id,
  });
  if (credentialError || !credential) {
    return NextResponse.json({ status: "error", error: "credential_resolution_failed" }, { status: 500 });
  }

  try {
    const adapter = resolveProviderAdapter(socialAccount);
    const rawResponse = await adapter.getMetrics({ credential, externalPublicationId: mediaId, socialAccount });

    // Safety check on the redacted-but-real raw payload before this route
    // ever discards it — never returned in the response body either way.
    const rawContainsLiveTokenPattern = /access_token=(?!\[REDACTED\])[^&"]+/.test(JSON.stringify(rawResponse.payload));

    const normalize = resolveNormalizer(rawResponse.provider);
    const observation = normalize(rawResponse, { collectedAt: new Date().toISOString() });

    return NextResponse.json({
      status: "ok",
      mediaId,
      provider: rawResponse.provider,
      metrics: observation.metrics,
      metricStates: observation.metricStates,
      capturedAt: observation.capturedAt,
      capturedAtProvenance: observation.capturedAtProvenance,
      engagementRate: observation.engagementRate,
      rawPayloadContainedLiveAccessToken: rawContainsLiveTokenPattern,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Instagram media verification failed";
    return NextResponse.json({ status: "error", error: "verification_failed", message }, { status: 502 });
  }
}
