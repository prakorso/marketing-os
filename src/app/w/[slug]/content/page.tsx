import { notFound } from "next/navigation";
import Link from "next/link";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { getCurrentUserRole, getWorkspaceBySlug } from "@/server/services/workspaces";
import { listBrandsForWorkspace } from "@/server/services/brands";
import { listContentBriefsForWorkspace, listContentForWorkspace } from "@/server/services/content";
import type { ContentStatus } from "@/types/database";

import { createContentAction } from "./actions";

const CONTENT_STATUSES: ContentStatus[] = ["draft", "in_review", "approved", "changes_requested", "archived"];

const inputClass =
  "rounded-control border border-outline-variant bg-surface-container-lowest px-space-md py-space-sm font-body text-body-md text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:ring-2 focus:ring-secondary";
const labelClass = "font-label text-label-sm font-semibold text-on-surface";

export default async function ContentListPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ status?: string; brand?: string }>;
}) {
  const { slug } = await params;
  const { status, brand } = await searchParams;

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    notFound();
  }

  const contentStatus = CONTENT_STATUSES.includes(status as ContentStatus) ? (status as ContentStatus) : undefined;

  const [items, brands, briefs, role] = await Promise.all([
    listContentForWorkspace(workspace.id, { status: contentStatus, brandId: brand || undefined }),
    listBrandsForWorkspace(workspace.id),
    listContentBriefsForWorkspace(workspace.id),
    getCurrentUserRole(workspace.id),
  ]);
  const canEdit = role === "owner" || role === "admin" || role === "marketer";
  const brandNameById = new Map(brands.map((b) => [b.id, b.name]));

  return (
    <div className="flex flex-col gap-space-lg">
      <PageHeader
        eyebrow="MOS // Content Studio"
        title="Content"
        description={`Briefs, versions, variants, and approvals for this workspace. ${items.length} shown.`}
      />

      <form method="get" className="flex flex-wrap items-end gap-space-md">
        <div className="flex flex-col gap-space-xs">
          <label htmlFor="status" className={labelClass}>
            Status
          </label>
          <select id="status" name="status" defaultValue={contentStatus ?? ""} className={inputClass}>
            <option value="">All statuses</option>
            {CONTENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-space-xs">
          <label htmlFor="brand" className={labelClass}>
            Brand
          </label>
          <select id="brand" name="brand" defaultValue={brand ?? ""} className={inputClass}>
            <option value="">All brands</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="secondary">
          Apply filters
        </Button>
      </form>

      {items.length === 0 ? (
        <EmptyState
          title="No content yet"
          description={
            canEdit
              ? brands.length === 0
                ? "Create a brand first, then start your first piece of content."
                : "Create your first piece of content to begin the Brief → Version → Variant → Approval loop."
              : "No content has been created in this workspace yet."
          }
        />
      ) : (
        <div className="flex flex-col gap-space-sm">
          {items.map((item) => (
            <Link key={item.id} href={`/w/${slug}/content/${item.id}`}>
              <Card className="flex items-center justify-between transition-colors hover:border-outline">
                <div className="flex flex-col gap-space-xs">
                  <span className="font-body text-body-md font-semibold text-on-surface">{item.title}</span>
                  <span className="font-label text-label-sm text-on-surface-variant">
                    {brandNameById.get(item.brand_id) ?? "—"}
                    {item.content_type ? ` · ${item.content_type}` : ""} · updated{" "}
                    {new Date(item.updated_at).toLocaleDateString()}
                  </span>
                </div>
                <Badge variant={item.status === "approved" ? "active" : "neutral"}>{item.status}</Badge>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {canEdit && brands.length > 0 ? (
        <Card className="max-w-lg">
          <span className="font-label text-label-sm uppercase tracking-wider text-secondary font-semibold">
            Create Content
          </span>
          <form action={createContentAction} className="mt-space-md flex flex-col gap-space-md">
            <input type="hidden" name="slug" value={slug} />
            <div className="flex flex-col gap-space-xs">
              <label htmlFor="title" className={labelClass}>
                Title
              </label>
              <input id="title" name="title" required placeholder="Content title" className={inputClass} />
            </div>
            <div className="flex flex-col gap-space-xs">
              <label htmlFor="brand_id" className={labelClass}>
                Brand
              </label>
              <select id="brand_id" name="brand_id" required className={inputClass}>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-space-xs">
              <label htmlFor="content_type" className={labelClass}>
                Content type (optional)
              </label>
              <input
                id="content_type"
                name="content_type"
                placeholder="e.g. carousel, single-image, article"
                className={inputClass}
              />
            </div>
            {briefs.length > 0 ? (
              <div className="flex flex-col gap-space-xs">
                <label htmlFor="brief_id" className={labelClass}>
                  Brief (optional)
                </label>
                <select id="brief_id" name="brief_id" defaultValue="" className={inputClass}>
                  <option value="">No brief</option>
                  {briefs.map((brief) => (
                    <option key={brief.id} value={brief.id}>
                      {brief.title}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <Button type="submit" className="self-start">
              Create content
            </Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
