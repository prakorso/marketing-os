import { notFound } from "next/navigation";
import Link from "next/link";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { getCurrentUserRole, getWorkspaceBySlug } from "@/server/services/workspaces";
import { getAssetSignedUrl, listAssetsForWorkspace } from "@/server/services/assets";
import type { AssetType } from "@/types/database";

import { uploadAssetAction } from "./actions";

const ASSET_TYPES: AssetType[] = ["image", "video", "audio", "document", "other"];

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function AssetsListPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ type?: string; archived?: string }>;
}) {
  const { slug } = await params;
  const { type, archived } = await searchParams;

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    notFound();
  }

  const assetType = ASSET_TYPES.includes(type as AssetType) ? (type as AssetType) : undefined;
  const includeArchived = archived === "true";

  const [assets, role] = await Promise.all([
    listAssetsForWorkspace(workspace.id, { assetType, includeArchived }),
    getCurrentUserRole(workspace.id),
  ]);
  const canEdit = role === "owner" || role === "admin" || role === "marketer";

  const thumbnails = await Promise.all(
    assets.map(async (asset) => [asset.id, await getAssetSignedUrl(asset)] as const),
  );
  const thumbnailByAssetId = new Map(thumbnails);

  return (
    <div className="flex flex-col gap-space-lg">
      <PageHeader
        eyebrow="MOS // Assets"
        title="Assets"
        description={`Media and files for this workspace. ${assets.length} shown.`}
      />

      <form method="get" className="flex flex-wrap items-end gap-space-md">
        <div className="flex flex-col gap-space-xs">
          <label htmlFor="type" className="font-label text-label-sm font-semibold text-on-surface">
            Type
          </label>
          <select
            id="type"
            name="type"
            defaultValue={assetType ?? ""}
            className="rounded-control border border-outline-variant bg-surface-container-lowest px-space-md py-space-sm font-body text-body-md text-on-surface"
          >
            <option value="">All types</option>
            {ASSET_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-space-xs pb-space-sm font-body text-body-sm text-on-surface">
          <input type="checkbox" name="archived" value="true" defaultChecked={includeArchived} />
          Include archived
        </label>
        <Button type="submit" variant="secondary">
          Apply filters
        </Button>
      </form>

      {assets.length === 0 ? (
        <EmptyState
          title="No assets yet"
          description={
            canEdit
              ? "Upload a file to start building this workspace's asset library."
              : "No assets have been uploaded to this workspace yet."
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-gutter-lg sm:grid-cols-2 lg:grid-cols-4">
          {assets.map((asset) => {
            const thumbnailUrl = thumbnailByAssetId.get(asset.id);
            return (
              <Link key={asset.id} href={`/w/${slug}/assets/${asset.id}`}>
                <Card className="flex h-full flex-col gap-space-sm p-space-md transition-colors hover:border-outline">
                  <div className="flex aspect-square items-center justify-center overflow-hidden rounded-control bg-surface-container-low">
                    {thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- signed, expiring private URL; not eligible for Next/Image's remote-domain optimization
                      <img src={thumbnailUrl} alt={asset.file_name} className="h-full w-full object-cover" />
                    ) : (
                      <span className="font-label text-label-sm uppercase text-on-surface-variant">
                        {asset.asset_type}
                      </span>
                    )}
                  </div>
                  <p className="truncate font-body text-body-sm font-semibold text-on-surface">{asset.file_name}</p>
                  <div className="flex items-center justify-between">
                    <Badge variant="neutral">{asset.asset_type}</Badge>
                    {asset.archived_at ? <Badge variant="neutral">archived</Badge> : null}
                  </div>
                  <span className="font-label text-label-sm text-on-surface-variant">
                    {formatFileSize(asset.file_size)}
                  </span>
                </Card>
              </Link>
            );
          })}
        </div>
      )}

      {canEdit ? (
        <Card className="max-w-lg">
          <span className="font-label text-label-sm uppercase tracking-wider text-secondary font-semibold">
            Upload Asset
          </span>
          <form action={uploadAssetAction} className="mt-space-md flex flex-col gap-space-md">
            <input type="hidden" name="slug" value={slug} />
            <input
              type="file"
              name="file"
              required
              className="font-body text-body-md text-on-surface file:mr-space-md file:rounded-control file:border-0 file:bg-primary file:px-space-md file:py-space-sm file:font-label file:text-label-md file:font-medium file:text-on-primary"
            />
            <Button type="submit" className="self-start">
              Upload
            </Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
