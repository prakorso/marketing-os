import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";

/**
 * Command Center. This is chrome only — the Stitch reference shows live
 * pipeline metrics, an AI recommendation, and a scheduled-content queue,
 * none of which are backed yet (they span Content, Distribution, Analytics
 * and AI domains, none of which have UI built in this phase). Rendering
 * fabricated numbers here would violate the no-fake-data rule, so this
 * page is an honest placeholder until those domains land.
 */
export default function CommandCenterPage() {
  return (
    <div className="flex flex-col gap-space-lg">
      <PageHeader
        eyebrow="MOS // Command Center"
        title="Marketing Command Center"
        description="Daily marketing operations, execution velocity, and high-impact actions."
      />
      <EmptyState
        title="Command Center is being built domain by domain"
        description="Pipeline velocity, AI recommendations, and the scheduled-content queue will appear here once Content, Distribution, and Analytics are implemented. This page confirms the application shell is working."
      />
    </div>
  );
}
