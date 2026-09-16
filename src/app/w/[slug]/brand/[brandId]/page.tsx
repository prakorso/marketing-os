import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { getCurrentUserRole, getWorkspaceBySlug } from "@/server/services/workspaces";
import { getBrandDetail } from "@/server/services/brands";

import {
  createAudienceProfileAction,
  createContentPillarAction,
  setBrandStatusAction,
  updateBrandAction,
  updateBrandVoiceAction,
} from "../actions";

const inputClass =
  "rounded-control border border-outline-variant bg-surface-container-lowest px-space-md py-space-sm font-body text-body-md text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:ring-2 focus:ring-secondary";
const labelClass = "font-label text-label-sm font-semibold text-on-surface";
const sectionEyebrowClass = "font-label text-label-sm uppercase tracking-wider text-secondary font-semibold";

function JsonPreview({ value }: { value: unknown }) {
  return (
    <pre className="overflow-x-auto rounded-control bg-surface-container-low p-space-md font-label text-label-sm text-on-surface-variant">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export default async function BrandDetailPage({
  params,
}: {
  params: Promise<{ slug: string; brandId: string }>;
}) {
  const { slug, brandId } = await params;

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    notFound();
  }

  const [detail, role] = await Promise.all([
    getBrandDetail(workspace.id, brandId),
    getCurrentUserRole(workspace.id),
  ]);
  if (!detail) {
    notFound();
  }

  const { brand, identity, voice, audienceProfiles, pillars } = detail;
  const canEdit = role === "owner" || role === "admin" || role === "marketer";

  return (
    <div className="flex flex-col gap-space-xl">
      <PageHeader
        eyebrow="MOS // Brand"
        title={brand.name}
        description={brand.description ?? undefined}
        actions={
          <>
            <Badge variant={brand.status === "active" ? "active" : "neutral"}>{brand.status}</Badge>
            {canEdit ? (
              <form action={setBrandStatusAction}>
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="brand_id" value={brand.id} />
                <input type="hidden" name="status" value={brand.status === "active" ? "archived" : "active"} />
                <Button type="submit" variant="secondary">
                  {brand.status === "active" ? "Archive" : "Restore"}
                </Button>
              </form>
            ) : null}
          </>
        }
      />

      {/* Brand details */}
      <Card className="flex flex-col gap-space-md">
        <span className={sectionEyebrowClass}>Brand Details</span>
        {canEdit ? (
          <form action={updateBrandAction} className="flex flex-col gap-space-md">
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="brand_id" value={brand.id} />
            <div className="grid grid-cols-1 gap-space-md md:grid-cols-2">
              <div className="flex flex-col gap-space-xs">
                <label htmlFor="name" className={labelClass}>
                  Name
                </label>
                <input id="name" name="name" defaultValue={brand.name} required className={inputClass} />
              </div>
              <div className="flex flex-col gap-space-xs">
                <label htmlFor="website_url" className={labelClass}>
                  Website
                </label>
                <input
                  id="website_url"
                  name="website_url"
                  type="url"
                  defaultValue={brand.website_url ?? ""}
                  placeholder="https://example.com"
                  className={inputClass}
                />
              </div>
            </div>
            <div className="flex flex-col gap-space-xs">
              <label htmlFor="description" className={labelClass}>
                Description
              </label>
              <input
                id="description"
                name="description"
                defaultValue={brand.description ?? ""}
                className={inputClass}
              />
            </div>
            <Button type="submit" variant="secondary" className="self-start">
              Save details
            </Button>
          </form>
        ) : (
          <dl className="grid grid-cols-1 gap-space-sm md:grid-cols-2">
            <div>
              <dt className="font-label text-label-sm text-on-surface-variant">Website</dt>
              <dd className="font-body text-body-md text-on-surface">{brand.website_url ?? "—"}</dd>
            </div>
          </dl>
        )}
      </Card>

      {/* Brand voice */}
      <Card className="flex flex-col gap-space-md">
        <span className={sectionEyebrowClass}>Brand Voice</span>
        {canEdit ? (
          <form action={updateBrandVoiceAction} className="flex flex-col gap-space-md">
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="brand_id" value={brand.id} />
            <div className="grid grid-cols-1 gap-space-md md:grid-cols-2">
              <div className="flex flex-col gap-space-xs">
                <label htmlFor="tone" className={labelClass}>
                  Tone
                </label>
                <input id="tone" name="tone" defaultValue={voice?.tone ?? ""} className={inputClass} />
              </div>
              <div className="flex flex-col gap-space-xs">
                <label htmlFor="personality" className={labelClass}>
                  Personality
                </label>
                <input
                  id="personality"
                  name="personality"
                  defaultValue={voice?.personality ?? ""}
                  className={inputClass}
                />
              </div>
            </div>
            <div className="flex flex-col gap-space-xs">
              <label htmlFor="writing_guidelines" className={labelClass}>
                Writing guidelines
              </label>
              <textarea
                id="writing_guidelines"
                name="writing_guidelines"
                defaultValue={voice?.writing_guidelines ?? ""}
                rows={3}
                className={inputClass}
              />
            </div>
            <Button type="submit" variant="secondary" className="self-start">
              Save voice
            </Button>
          </form>
        ) : voice ? (
          <dl className="grid grid-cols-1 gap-space-sm md:grid-cols-2">
            <div>
              <dt className="font-label text-label-sm text-on-surface-variant">Tone</dt>
              <dd className="font-body text-body-md text-on-surface">{voice.tone ?? "—"}</dd>
            </div>
            <div>
              <dt className="font-label text-label-sm text-on-surface-variant">Personality</dt>
              <dd className="font-body text-body-md text-on-surface">{voice.personality ?? "—"}</dd>
            </div>
          </dl>
        ) : (
          <p className="font-body text-body-sm text-on-surface-variant">No brand voice defined yet.</p>
        )}
        {voice?.preferred_terms || voice?.avoid_terms || voice?.example_copy ? (
          <div className="flex flex-col gap-space-sm pt-space-sm">
            <span className="font-label text-label-sm text-on-surface-variant">
              Additional voice data (preferred/avoid terms, example copy)
            </span>
            <JsonPreview
              value={{
                preferred_terms: voice?.preferred_terms,
                avoid_terms: voice?.avoid_terms,
                example_copy: voice?.example_copy,
              }}
            />
          </div>
        ) : null}
      </Card>

      {/* Visual identity — read-only for this slice: primary_colors/secondary_colors/
          typography/visual_guidelines are JSONB with no canonical shape specified
          in Database Architecture §3, so this slice displays whatever exists
          rather than inventing a structure to edit. */}
      <Card className="flex flex-col gap-space-md">
        <span className={sectionEyebrowClass}>Visual Identity</span>
        {identity ? (
          <JsonPreview
            value={{
              primary_colors: identity.primary_colors,
              secondary_colors: identity.secondary_colors,
              typography: identity.typography,
              visual_guidelines: identity.visual_guidelines,
            }}
          />
        ) : (
          <p className="font-body text-body-sm text-on-surface-variant">No visual identity defined yet.</p>
        )}
      </Card>

      {/* Audience profiles */}
      <Card className="flex flex-col gap-space-md">
        <span className={sectionEyebrowClass}>Audience Profiles</span>
        {audienceProfiles.length === 0 ? (
          <EmptyState title="No audience profiles yet" />
        ) : (
          <div className="grid grid-cols-1 gap-space-md md:grid-cols-2">
            {audienceProfiles.map((profile) => (
              <div key={profile.id} className="rounded-control border border-outline-variant p-space-md">
                <p className="font-body text-body-md font-semibold text-on-surface">{profile.name}</p>
                {profile.description ? (
                  <p className="mt-space-xs font-body text-body-sm text-on-surface-variant">{profile.description}</p>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {canEdit ? (
          <form action={createAudienceProfileAction} className="flex flex-col gap-space-sm pt-space-sm md:flex-row md:items-end">
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="brand_id" value={brand.id} />
            <div className="flex flex-1 flex-col gap-space-xs">
              <label htmlFor="audience-name" className={labelClass}>
                New audience profile name
              </label>
              <input id="audience-name" name="name" required placeholder="e.g. Enterprise buyers" className={inputClass} />
            </div>
            <div className="flex flex-1 flex-col gap-space-xs">
              <label htmlFor="audience-description" className={labelClass}>
                Description
              </label>
              <input id="audience-description" name="description" className={inputClass} />
            </div>
            <Button type="submit" variant="secondary">
              Add
            </Button>
          </form>
        ) : null}
      </Card>

      {/* Content pillars */}
      <Card className="flex flex-col gap-space-md">
        <span className={sectionEyebrowClass}>Content Pillars</span>
        {pillars.length === 0 ? (
          <EmptyState title="No content pillars yet" />
        ) : (
          <div className="grid grid-cols-1 gap-space-md md:grid-cols-2">
            {pillars.map((pillar) => (
              <div key={pillar.id} className="rounded-control border border-outline-variant p-space-md">
                <div className="flex items-center justify-between">
                  <p className="font-body text-body-md font-semibold text-on-surface">{pillar.name}</p>
                  {pillar.priority !== null ? (
                    <span className="font-label text-label-sm text-on-surface-variant">
                      Priority {pillar.priority}
                    </span>
                  ) : null}
                </div>
                {pillar.description ? (
                  <p className="mt-space-xs font-body text-body-sm text-on-surface-variant">{pillar.description}</p>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {canEdit ? (
          <form action={createContentPillarAction} className="flex flex-col gap-space-sm pt-space-sm md:flex-row md:items-end">
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="brand_id" value={brand.id} />
            <div className="flex flex-1 flex-col gap-space-xs">
              <label htmlFor="pillar-name" className={labelClass}>
                New content pillar name
              </label>
              <input id="pillar-name" name="name" required placeholder="e.g. Product education" className={inputClass} />
            </div>
            <div className="flex flex-1 flex-col gap-space-xs">
              <label htmlFor="pillar-description" className={labelClass}>
                Description
              </label>
              <input id="pillar-description" name="description" className={inputClass} />
            </div>
            <div className="flex w-24 flex-col gap-space-xs">
              <label htmlFor="pillar-priority" className={labelClass}>
                Priority
              </label>
              <input id="pillar-priority" name="priority" type="number" className={inputClass} />
            </div>
            <Button type="submit" variant="secondary">
              Add
            </Button>
          </form>
        ) : null}
      </Card>
    </div>
  );
}
