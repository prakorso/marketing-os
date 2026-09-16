import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { getCurrentUserRole, getWorkspaceBySlug } from "@/server/services/workspaces";
import { listSocialAccountsForWorkspace } from "@/server/services/social-accounts";
import type { SocialAccountStatus, SocialPlatform } from "@/types/database";

import { connectSocialAccountAction, disconnectSocialAccountAction } from "./actions";

const SOCIAL_PLATFORMS: SocialPlatform[] = ["instagram", "tiktok", "youtube", "threads"];

const PLATFORM_LABEL: Record<SocialPlatform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  threads: "Threads",
};

const STATUS_BADGE_VARIANT: Record<SocialAccountStatus, "neutral" | "active" | "alert"> = {
  connected: "active",
  disconnected: "neutral",
  expired: "alert",
  revoked: "alert",
  error: "alert",
};

const inputClass =
  "rounded-control border border-outline-variant bg-surface-container-lowest px-space-md py-space-sm font-body text-body-md text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:ring-2 focus:ring-secondary";
const labelClass = "font-label text-label-sm font-semibold text-on-surface";

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    notFound();
  }

  const [accounts, role] = await Promise.all([
    listSocialAccountsForWorkspace(workspace.id),
    getCurrentUserRole(workspace.id),
  ]);
  const canEdit = role === "owner" || role === "admin" || role === "marketer";

  return (
    <div className="flex flex-col gap-space-lg">
      <PageHeader
        eyebrow="MOS // Settings"
        title="Connected Accounts"
        description={`Social platform connections for this workspace. ${accounts.length} shown.`}
      />

      {accounts.length === 0 ? (
        <EmptyState
          title="No connected accounts yet"
          description={
            canEdit
              ? "Connect a social account below to begin distribution setup."
              : "No social accounts have been connected in this workspace yet."
          }
        />
      ) : (
        <div className="flex flex-col gap-space-sm">
          {accounts.map((account) => (
            <Card key={account.id} className="flex items-center justify-between gap-space-md">
              <div className="flex flex-col gap-space-xs">
                <div className="flex items-center gap-space-sm">
                  <span className="font-body text-body-md font-semibold text-on-surface">
                    {PLATFORM_LABEL[account.platform]}
                  </span>
                  <Badge variant={STATUS_BADGE_VARIANT[account.status]}>{account.status}</Badge>
                </div>
                <span className="font-label text-label-sm text-on-surface-variant">
                  {account.account_name}
                  {account.account_handle ? ` · @${account.account_handle}` : ""} · connected{" "}
                  {new Date(account.connected_at).toLocaleDateString()}
                </span>
              </div>
              {canEdit && account.status === "connected" ? (
                <form action={disconnectSocialAccountAction}>
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="account_id" value={account.id} />
                  <Button type="submit" variant="secondary">
                    Disconnect
                  </Button>
                </form>
              ) : null}
            </Card>
          ))}
        </div>
      )}

      {canEdit ? (
        <Card className="max-w-lg">
          <span className="font-label text-label-sm uppercase tracking-wider text-secondary font-semibold">
            Connect Account
          </span>
          <p className="mt-space-xs font-body text-body-sm text-on-surface-variant">
            Manual credential entry for development — this does not perform a real OAuth handshake.
          </p>
          <form action={connectSocialAccountAction} className="mt-space-md flex flex-col gap-space-md">
            <input type="hidden" name="slug" value={slug} />
            <div className="flex flex-col gap-space-xs">
              <label htmlFor="platform" className={labelClass}>
                Platform
              </label>
              <select id="platform" name="platform" required className={inputClass}>
                {SOCIAL_PLATFORMS.map((platform) => (
                  <option key={platform} value={platform}>
                    {PLATFORM_LABEL[platform]}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-space-xs">
              <label htmlFor="external_account_id" className={labelClass}>
                Provider account ID
              </label>
              <input
                id="external_account_id"
                name="external_account_id"
                required
                placeholder="Provider's account identifier"
                className={inputClass}
              />
            </div>
            <div className="flex flex-col gap-space-xs">
              <label htmlFor="account_name" className={labelClass}>
                Account name
              </label>
              <input id="account_name" name="account_name" required className={inputClass} />
            </div>
            <div className="flex flex-col gap-space-xs">
              <label htmlFor="account_handle" className={labelClass}>
                Handle (optional)
              </label>
              <input id="account_handle" name="account_handle" className={inputClass} />
            </div>
            <div className="flex flex-col gap-space-xs">
              <label htmlFor="credential" className={labelClass}>
                Credential
              </label>
              <input
                id="credential"
                name="credential"
                type="password"
                required
                autoComplete="off"
                placeholder="Access token (dev/manual entry, stored in Vault)"
                className={inputClass}
              />
            </div>
            <Button type="submit" className="self-start">
              Connect
            </Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
