import { notFound } from "next/navigation";
import Link from "next/link";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/layout/PageHeader";
import { getCurrentUserRole, getWorkspaceBySlug } from "@/server/services/workspaces";
import { getAssetDetail, getAssetSignedUrl } from "@/server/services/assets";

import { setAssetArchivedAction } from "../actions";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function AssetDetailPage({
  params,
}: {
  params: Promise<{ slug: string; assetId: string }>;
}) {
  const { slug, assetId } = await params;

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    notFound();
  }

  // Scoped by BOTH workspace_id and asset id — an asset from another
  // workspace resolves to null here regardless of RLS, and RLS itself
  // would already deny it if this check were somehow skipped.
  const asset = await getAssetDetail(workspace.id, assetId);
  if (!asset) {
    notFound();
  }

  const [role, previewUrl] = await Promise.all([getCurrentUserRole(workspace.id), getAssetSignedUrl(asset)]);
  const canEdit = role === "owner" || role === "admin" || role === "marketer";

  return (
    <div className="flex flex-col gap-space-xl">
      <PageHeader
        eyebrow="MOS // Assets"
        title={asset.file_name}
        actions={
          <>
            <Badge variant={asset.archived_at ? "neutral" : "active"}>
              {asset.archived_at ? "archived" : "active"}
            </Badge>
            {canEdit ? (
              <form action={setAssetArchivedAction}>
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="asset_id" value={asset.id} />
                <input type="hidden" name="archived" value={asset.archived_at ? "false" : "true"} />
                <Button type="submit" variant="secondary">
                  {asset.archived_at ? "Restore" : "Archive"}
                </Button>
              </form>
            ) : null}
          </>
        }
      />

      <div className="grid grid-cols-1 gap-gutter-lg lg:grid-cols-2">
        <Card className="flex aspect-video items-center justify-center overflow-hidden bg-surface-container-low">
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- signed, expiring private URL
            <img src={previewUrl} alt={asset.file_name} className="h-full w-full object-contain" />
          ) : (
            <span className="font-label text-label-lg uppercase text-on-surface-variant">{asset.asset_type}</span>
          )}
        </Card>

        <Card className="flex flex-col gap-space-md">
          <span className="font-label text-label-sm uppercase tracking-wider text-secondary font-semibold">
            Metadata
          </span>
          <dl className="grid grid-cols-2 gap-space-md">
            <div>
              <dt className="font-label text-label-sm text-on-surface-variant">Type</dt>
              <dd className="font-body text-body-md text-on-surface">{asset.asset_type}</dd>
            </div>
            <div>
              <dt className="font-label text-label-sm text-on-surface-variant">MIME type</dt>
              <dd className="font-body text-body-md text-on-surface">{asset.mime_type}</dd>
            </div>
            <div>
              <dt className="font-label text-label-sm text-on-surface-variant">File size</dt>
              <dd className="font-body text-body-md text-on-surface">{formatFileSize(asset.file_size)}</dd>
            </div>
            {asset.width && asset.height ? (
              <div>
                <dt className="font-label text-label-sm text-on-surface-variant">Dimensions</dt>
                <dd className="font-body text-body-md text-on-surface">
                  {asset.width} × {asset.height}
                </dd>
              </div>
            ) : null}
            {asset.duration_ms ? (
              <div>
                <dt className="font-label text-label-sm text-on-surface-variant">Duration</dt>
                <dd className="font-body text-body-md text-on-surface">
                  {(asset.duration_ms / 1000).toFixed(1)}s
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="font-label text-label-sm text-on-surface-variant">Uploaded</dt>
              <dd className="font-body text-body-md text-on-surface">
                {new Date(asset.created_at).toLocaleString()}
              </dd>
            </div>
          </dl>
        </Card>
      </div>

      <Link
        href={`/w/${slug}/assets`}
        className="self-start font-label text-label-sm font-semibold text-on-surface-variant hover:text-on-surface"
      >
        ← Back to Assets
      </Link>
    </div>
  );
}
