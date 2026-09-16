import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { getCurrentUserRole, getWorkspaceBySlug } from "@/server/services/workspaces";
import { getBrandDetail, listBrandsForWorkspace } from "@/server/services/brands";
import { getAssetSignedUrl, listAssetsForWorkspace } from "@/server/services/assets";
import {
  getContent,
  getContentBrief,
  listContentApprovals,
  listContentBriefsForWorkspace,
  listContentVariants,
  listContentVersions,
  listLinkedAssets,
} from "@/server/services/content";
import type { ContentApprovalStatus, ContentStatus, ContentVariantStatus } from "@/types/database";

import {
  attachAssetAction,
  createContentApprovalAction,
  createContentBriefAction,
  createContentVariantAction,
  createContentVersionAction,
  detachAssetAction,
  updateContentBriefAction,
  updateContentStatusAction,
  updateContentVariantAction,
} from "../actions";

const CONTENT_STATUSES: ContentStatus[] = ["draft", "in_review", "approved", "changes_requested", "archived"];
const VARIANT_STATUSES: ContentVariantStatus[] = ["draft", "ready", "approved", "archived"];
const APPROVAL_STATUSES: ContentApprovalStatus[] = ["pending", "approved", "changes_requested", "rejected"];

const inputClass =
  "rounded-control border border-outline-variant bg-surface-container-lowest px-space-md py-space-sm font-body text-body-md text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:ring-2 focus:ring-secondary";
const labelClass = "font-label text-label-sm font-semibold text-on-surface";
const sectionEyebrowClass = "font-label text-label-sm uppercase tracking-wider text-secondary font-semibold";

export default async function ContentDetailPage({
  params,
}: {
  params: Promise<{ slug: string; contentId: string }>;
}) {
  const { slug, contentId } = await params;

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    notFound();
  }

  const content = await getContent(workspace.id, contentId);
  if (!content) {
    notFound();
  }

  const [
    role,
    brands,
    brief,
    versions,
    linkedAssets,
    approvals,
    availableAssets,
    workspaceBriefs,
    brandDetail,
  ] = await Promise.all([
    getCurrentUserRole(workspace.id),
    listBrandsForWorkspace(workspace.id),
    content.brief_id ? getContentBrief(workspace.id, content.brief_id) : Promise.resolve(null),
    listContentVersions(workspace.id, content.id),
    listLinkedAssets(workspace.id, content.id),
    listContentApprovals(workspace.id, content.id),
    listAssetsForWorkspace(workspace.id),
    listContentBriefsForWorkspace(workspace.id),
    getBrandDetail(workspace.id, content.brand_id),
  ]);

  const canEdit = role === "owner" || role === "admin" || role === "marketer";
  const canApprove = role === "owner" || role === "admin";
  const brandName = brands.find((b) => b.id === content.brand_id)?.name ?? "—";

  const versionsWithVariants = await Promise.all(
    versions.map(async (version) => ({
      version,
      variants: await listContentVariants(workspace.id, version.id),
    })),
  );

  const linkedAssetIds = new Set(linkedAssets.map((la) => la.asset_id));
  const attachableAssets = availableAssets.filter((a) => !linkedAssetIds.has(a.id));
  const thumbnails = await Promise.all(
    linkedAssets.map(async (la) => [la.asset_id, await getAssetSignedUrl(la.asset)] as const),
  );
  const thumbnailByAssetId = new Map(thumbnails);

  const otherWorkspaceBriefsForBrand = workspaceBriefs.filter((b) => b.brand_id === content.brand_id);

  return (
    <div className="flex flex-col gap-space-xl">
      <PageHeader
        eyebrow="MOS // Content Studio"
        title={content.title}
        description={`${brandName}${content.content_type ? ` · ${content.content_type}` : ""}`}
        actions={
          <>
            <Badge variant={content.status === "approved" ? "active" : "neutral"}>{content.status}</Badge>
            {canEdit ? (
              <form action={updateContentStatusAction} className="flex items-center gap-space-xs">
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="content_id" value={content.id} />
                <select name="status" defaultValue={content.status} className={inputClass}>
                  {CONTENT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <Button type="submit" variant="secondary">
                  Update status
                </Button>
              </form>
            ) : null}
          </>
        }
      />

      <div className="grid grid-cols-1 gap-gutter-lg lg:grid-cols-3">
        {/* LEFT: Brief context */}
        <div className="flex flex-col gap-space-lg lg:col-span-1">
          <Card className="flex flex-col gap-space-md">
            <span className={sectionEyebrowClass}>Creative Brief</span>
            {brief ? (
              canEdit ? (
                <form action={updateContentBriefAction} className="flex flex-col gap-space-sm">
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="content_id" value={content.id} />
                  <input type="hidden" name="brief_id" value={brief.id} />
                  <input type="hidden" name="brand_id" value={brief.brand_id} />
                  <label className={labelClass} htmlFor="brief-title">
                    Title
                  </label>
                  <input id="brief-title" name="title" defaultValue={brief.title} className={inputClass} />
                  <label className={labelClass} htmlFor="brief-objective">
                    Objective
                  </label>
                  <input id="brief-objective" name="objective" defaultValue={brief.objective ?? ""} className={inputClass} />
                  <label className={labelClass} htmlFor="brief-angle">
                    Angle
                  </label>
                  <input id="brief-angle" name="angle" defaultValue={brief.angle ?? ""} className={inputClass} />
                  <label className={labelClass} htmlFor="brief-core-message">
                    Core message
                  </label>
                  <input
                    id="brief-core-message"
                    name="core_message"
                    defaultValue={brief.core_message ?? ""}
                    className={inputClass}
                  />
                  <label className={labelClass} htmlFor="brief-cta">
                    CTA
                  </label>
                  <input id="brief-cta" name="cta" defaultValue={brief.cta ?? ""} className={inputClass} />
                  <label className={labelClass} htmlFor="brief-format">
                    Format
                  </label>
                  <input id="brief-format" name="format" defaultValue={brief.format ?? ""} className={inputClass} />
                  <Button type="submit" variant="secondary" className="mt-space-xs self-start">
                    Save brief
                  </Button>
                </form>
              ) : (
                <dl className="flex flex-col gap-space-sm">
                  <div>
                    <dt className="font-label text-label-sm text-on-surface-variant">Objective</dt>
                    <dd className="font-body text-body-sm text-on-surface">{brief.objective ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="font-label text-label-sm text-on-surface-variant">Angle</dt>
                    <dd className="font-body text-body-sm text-on-surface">{brief.angle ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="font-label text-label-sm text-on-surface-variant">Core message</dt>
                    <dd className="font-body text-body-sm text-on-surface">{brief.core_message ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="font-label text-label-sm text-on-surface-variant">CTA</dt>
                    <dd className="font-body text-body-sm text-on-surface">{brief.cta ?? "—"}</dd>
                  </div>
                </dl>
              )
            ) : (
              <>
                <p className="font-body text-body-sm text-on-surface-variant">No brief attached yet.</p>
                {canEdit ? (
                  <form action={createContentBriefAction} className="flex flex-col gap-space-sm">
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="content_id" value={content.id} />
                    <input type="hidden" name="brand_id" value={content.brand_id} />
                    <label className={labelClass} htmlFor="new-brief-title">
                      Title
                    </label>
                    <input id="new-brief-title" name="title" required className={inputClass} />
                    <label className={labelClass} htmlFor="new-brief-objective">
                      Objective
                    </label>
                    <input id="new-brief-objective" name="objective" className={inputClass} />
                    <label className={labelClass} htmlFor="new-brief-angle">
                      Angle
                    </label>
                    <input id="new-brief-angle" name="angle" className={inputClass} />
                    <label className={labelClass} htmlFor="new-brief-core-message">
                      Core message
                    </label>
                    <input id="new-brief-core-message" name="core_message" className={inputClass} />
                    <label className={labelClass} htmlFor="new-brief-cta">
                      CTA
                    </label>
                    <input id="new-brief-cta" name="cta" className={inputClass} />
                    <Button type="submit" variant="secondary" className="mt-space-xs self-start">
                      Create brief
                    </Button>
                  </form>
                ) : null}
                {otherWorkspaceBriefsForBrand.length > 0 ? (
                  <p className="font-label text-label-sm text-on-surface-variant">
                    {otherWorkspaceBriefsForBrand.length} existing brief(s) for this brand are also available to link
                    from the content list&apos;s create form.
                  </p>
                ) : null}
              </>
            )}
          </Card>

          {brandDetail?.audienceProfiles.length || brandDetail?.pillars.length ? (
            <Card className="flex flex-col gap-space-sm">
              <span className={sectionEyebrowClass}>Brand Context</span>
              <p className="font-label text-label-sm text-on-surface-variant">
                {brandDetail.audienceProfiles.length} audience profile(s), {brandDetail.pillars.length} content
                pillar(s) defined for {brandName}.
              </p>
            </Card>
          ) : null}
        </div>

        {/* RIGHT: Versions, Variants, Assets, Approvals */}
        <div className="flex flex-col gap-space-lg lg:col-span-2">
          <Card className="flex flex-col gap-space-md">
            <span className={sectionEyebrowClass}>Versions</span>
            <p className="font-body text-body-sm text-on-surface-variant">
              Immutable creative history. Regenerating or editing never changes an existing version — it always
              creates a new one.
            </p>

            {versionsWithVariants.length === 0 ? (
              <EmptyState title="No versions yet" description="Create the first version to start this content." />
            ) : (
              <div className="flex flex-col gap-space-md">
                {versionsWithVariants.map(({ version, variants }) => (
                  <div key={version.id} className="rounded-control border border-outline-variant p-space-md">
                    <div className="flex items-center justify-between">
                      <span className="font-label text-label-md font-bold text-primary">
                        v{version.version_number}
                      </span>
                      <span className="font-label text-label-sm text-on-surface-variant">
                        {version.generation_method} · {new Date(version.created_at).toLocaleString()}
                      </span>
                    </div>
                    <p className="mt-space-xs whitespace-pre-wrap font-body text-body-sm text-on-surface">
                      {typeof version.content_payload === "object" &&
                      version.content_payload &&
                      "text" in version.content_payload
                        ? String((version.content_payload as { text: unknown }).text)
                        : JSON.stringify(version.content_payload)}
                    </p>

                    <div className="mt-space-md flex flex-col gap-space-sm border-t border-outline-variant pt-space-sm">
                      <span className="font-label text-label-sm uppercase tracking-wider text-on-surface-variant">
                        Variants
                      </span>
                      {variants.length === 0 ? (
                        <p className="font-body text-body-sm text-on-surface-variant">No variants yet.</p>
                      ) : (
                        <div className="flex flex-col gap-space-xs">
                          {variants.map((variant) => (
                            <div
                              key={variant.id}
                              className="flex items-center justify-between rounded-control bg-surface-container-low px-space-md py-space-sm"
                            >
                              <div className="flex flex-col">
                                <span className="font-body text-body-sm font-semibold text-on-surface">
                                  {variant.platform || "Unspecified platform"}
                                  {variant.format ? ` · ${variant.format}` : ""}
                                </span>
                                {variant.caption ? (
                                  <span className="font-body text-body-sm text-on-surface-variant">
                                    {variant.caption}
                                  </span>
                                ) : null}
                              </div>
                              {canEdit ? (
                                <form action={updateContentVariantAction} className="flex items-center gap-space-xs">
                                  <input type="hidden" name="slug" value={slug} />
                                  <input type="hidden" name="content_id" value={content.id} />
                                  <input type="hidden" name="variant_id" value={variant.id} />
                                  <select name="status" defaultValue={variant.status} className={inputClass}>
                                    {VARIANT_STATUSES.map((s) => (
                                      <option key={s} value={s}>
                                        {s}
                                      </option>
                                    ))}
                                  </select>
                                  <Button type="submit" variant="tertiary">
                                    Update
                                  </Button>
                                </form>
                              ) : (
                                <Badge variant="neutral">{variant.status}</Badge>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {canEdit ? (
                        <form
                          action={createContentVariantAction}
                          className="flex flex-wrap items-end gap-space-sm pt-space-xs"
                        >
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="content_id" value={content.id} />
                          <input type="hidden" name="content_version_id" value={version.id} />
                          <input name="platform" placeholder="Platform (e.g. Instagram)" className={inputClass} />
                          <input name="format" placeholder="Format" className={inputClass} />
                          <input name="caption" placeholder="Caption" className={inputClass} />
                          <Button type="submit" variant="secondary">
                            Add variant
                          </Button>
                        </form>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {canEdit ? (
              <form action={createContentVersionAction} className="flex flex-col gap-space-sm border-t border-outline-variant pt-space-md">
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="content_id" value={content.id} />
                <label className={labelClass} htmlFor="payload_text">
                  New version content
                </label>
                <textarea id="payload_text" name="payload_text" required rows={4} className={inputClass} />
                <label className={labelClass} htmlFor="generation_method">
                  Generation method
                </label>
                <input
                  id="generation_method"
                  name="generation_method"
                  defaultValue="human"
                  className={inputClass}
                />
                <Button type="submit" className="self-start">
                  Create new version
                </Button>
              </form>
            ) : null}
          </Card>

          <Card className="flex flex-col gap-space-md">
            <span className={sectionEyebrowClass}>Linked Assets</span>
            {linkedAssets.length === 0 ? (
              <EmptyState title="No assets linked yet" />
            ) : (
              <div className="grid grid-cols-2 gap-space-md sm:grid-cols-4">
                {linkedAssets.map((la) => {
                  const thumbnailUrl = thumbnailByAssetId.get(la.asset_id);
                  return (
                    <div key={la.asset_id} className="flex flex-col gap-space-xs">
                      <div className="flex aspect-square items-center justify-center overflow-hidden rounded-control bg-surface-container-low">
                        {thumbnailUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element -- signed, expiring private URL
                          <img src={thumbnailUrl} alt={la.asset.file_name} className="h-full w-full object-cover" />
                        ) : (
                          <span className="font-label text-label-sm uppercase text-on-surface-variant">
                            {la.asset.asset_type}
                          </span>
                        )}
                      </div>
                      <span className="truncate font-body text-body-sm text-on-surface">{la.asset.file_name}</span>
                      {canEdit ? (
                        <form action={detachAssetAction}>
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="content_id" value={content.id} />
                          <input type="hidden" name="asset_id" value={la.asset_id} />
                          <Button type="submit" variant="tertiary" className="w-full">
                            Remove
                          </Button>
                        </form>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}

            {canEdit && attachableAssets.length > 0 ? (
              <form action={attachAssetAction} className="flex flex-wrap items-end gap-space-sm border-t border-outline-variant pt-space-md">
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="content_id" value={content.id} />
                <div className="flex flex-col gap-space-xs">
                  <label className={labelClass} htmlFor="asset_id">
                    Attach existing asset
                  </label>
                  <select id="asset_id" name="asset_id" required className={inputClass}>
                    {attachableAssets.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.file_name}
                      </option>
                    ))}
                  </select>
                </div>
                <input name="role" placeholder="Role (optional, e.g. cover)" className={inputClass} />
                <Button type="submit" variant="secondary">
                  Attach
                </Button>
              </form>
            ) : null}
          </Card>

          <Card className="flex flex-col gap-space-md">
            <span className={sectionEyebrowClass}>Approval History</span>
            {approvals.length === 0 ? (
              <EmptyState title="No approval decisions yet" />
            ) : (
              <div className="flex flex-col gap-space-sm">
                {approvals.map((a) => (
                  <div key={a.id} className="rounded-control border border-outline-variant p-space-sm">
                    <div className="flex items-center justify-between">
                      <Badge variant={a.status === "approved" ? "active" : a.status === "rejected" ? "alert" : "neutral"}>
                        {a.status}
                      </Badge>
                      <span className="font-label text-label-sm text-on-surface-variant">
                        {new Date(a.created_at).toLocaleString()}
                      </span>
                    </div>
                    {a.comment ? <p className="mt-space-xs font-body text-body-sm text-on-surface">{a.comment}</p> : null}
                  </div>
                ))}
              </div>
            )}

            {canApprove ? (
              <form
                action={createContentApprovalAction}
                className="flex flex-col gap-space-sm border-t border-outline-variant pt-space-md"
              >
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="content_id" value={content.id} />
                <p className="font-label text-label-sm text-on-surface-variant">
                  Recording an approval decision is restricted to workspace owners/admins — a separate step from
                  content editing, by design.
                </p>
                <div className="flex flex-wrap items-end gap-space-sm">
                  <div className="flex flex-col gap-space-xs">
                    <label className={labelClass} htmlFor="approval-status">
                      Decision
                    </label>
                    <select id="approval-status" name="status" required className={inputClass}>
                      {APPROVAL_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                  {versions.length > 0 ? (
                    <div className="flex flex-col gap-space-xs">
                      <label className={labelClass} htmlFor="approval-version">
                        For version (optional)
                      </label>
                      <select id="approval-version" name="content_version_id" defaultValue="" className={inputClass}>
                        <option value="">Content-level (no specific version)</option>
                        {versions.map((v) => (
                          <option key={v.id} value={v.id}>
                            v{v.version_number}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                </div>
                <label className={labelClass} htmlFor="approval-comment">
                  Comment (optional)
                </label>
                <textarea id="approval-comment" name="comment" rows={2} className={inputClass} />
                <Button type="submit" className="self-start">
                  Record decision
                </Button>
              </form>
            ) : (
              <p className="font-label text-label-sm text-on-surface-variant">
                Only a workspace owner or admin can record approval decisions.
              </p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
