import { notFound } from "next/navigation";
import Link from "next/link";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { getCurrentUserRole, getWorkspaceBySlug } from "@/server/services/workspaces";
import { listBrandsForWorkspace } from "@/server/services/brands";

import { createBrandAction } from "./actions";

export default async function BrandListPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  // The workspace was already resolved (and membership verified) in the
  // parent layout; re-resolving here is a plain RLS-scoped read, not a
  // second authorization check — see getWorkspaceBySlug's own comment.
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    notFound();
  }

  const [brands, role] = await Promise.all([
    listBrandsForWorkspace(workspace.id),
    getCurrentUserRole(workspace.id),
  ]);
  const canEdit = role === "owner" || role === "admin" || role === "marketer";

  return (
    <div className="flex flex-col gap-space-lg">
      <PageHeader
        eyebrow="MOS // Brand"
        title="Brand"
        description="Brand identity, voice, audience profiles, and content pillars for this workspace."
      />

      {brands.length === 0 ? (
        <EmptyState
          title="No brands yet"
          description={
            canEdit
              ? "Create a brand to start defining its identity, voice, audience, and content pillars."
              : "No brand has been created in this workspace yet."
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-gutter-lg md:grid-cols-2 xl:grid-cols-3">
          {brands.map((brand) => (
            <Link key={brand.id} href={`/w/${slug}/brand/${brand.id}`}>
              <Card className="flex h-full flex-col gap-space-sm transition-colors hover:border-outline">
                <div className="flex items-center justify-between gap-space-sm">
                  <span className="font-headline text-headline-md font-bold text-on-surface">{brand.name}</span>
                  <Badge variant={brand.status === "active" ? "active" : "neutral"}>{brand.status}</Badge>
                </div>
                {brand.description ? (
                  <p className="line-clamp-2 font-body text-body-sm text-on-surface-variant">{brand.description}</p>
                ) : null}
              </Card>
            </Link>
          ))}
        </div>
      )}

      {canEdit ? (
        <Card className="max-w-lg">
          <form action={createBrandAction} className="flex flex-col gap-space-md">
            <input type="hidden" name="slug" value={slug} />
            <div className="flex flex-col gap-space-xs">
              <label htmlFor="name" className="font-label text-label-sm font-semibold text-on-surface">
                New brand name
              </label>
              <input
                id="name"
                name="name"
                required
                placeholder="Brand name"
                className="rounded-control border border-outline-variant bg-surface-container-lowest px-space-md py-space-sm font-body text-body-md text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:ring-2 focus:ring-secondary"
              />
            </div>
            <div className="flex flex-col gap-space-xs">
              <label htmlFor="description" className="font-label text-label-sm font-semibold text-on-surface">
                Description (optional)
              </label>
              <input
                id="description"
                name="description"
                placeholder="What this brand is"
                className="rounded-control border border-outline-variant bg-surface-container-lowest px-space-md py-space-sm font-body text-body-md text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:ring-2 focus:ring-secondary"
              />
            </div>
            <div className="flex flex-col gap-space-xs">
              <label htmlFor="website_url" className="font-label text-label-sm font-semibold text-on-surface">
                Website (optional)
              </label>
              <input
                id="website_url"
                name="website_url"
                type="url"
                placeholder="https://example.com"
                className="rounded-control border border-outline-variant bg-surface-container-lowest px-space-md py-space-sm font-body text-body-md text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:ring-2 focus:ring-secondary"
              />
            </div>
            <Button type="submit" className="self-start">
              Create brand
            </Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
