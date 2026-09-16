"use client";

import { usePathname } from "next/navigation";

import {
  AnalyticsIcon,
  AssetsIcon,
  AutomationIcon,
  BrandIcon,
  CalendarIcon,
  CampaignsIcon,
  CommandCenterIcon,
  ContentStudioIcon,
  IntelligenceIcon,
  PerformanceIcon,
  SettingsIcon,
} from "@/components/ui/icons";
import { NavItem } from "@/components/layout/NavItem";

type SidebarProps = {
  workspaceName: string;
  workspaceSlug: string;
};

/**
 * Primary navigation. Reflects the full product shape shown in Stitch, but
 * only screens that actually have a UI route implemented are real links —
 * every other module is rendered as a disabled placeholder so the shell
 * doesn't imply availability it doesn't have, regardless of whether its
 * backend exists.
 *
 * Active state is derived from the current pathname (client-side) rather
 * than passed down from the layout — this generalizes correctly as more
 * routes are added under /w/[slug], instead of the previous single
 * hardcoded "command-center" value.
 */
export function Sidebar({ workspaceName, workspaceSlug }: SidebarProps) {
  const pathname = usePathname();
  const base = `/w/${workspaceSlug}`;
  const isCommandCenter = pathname === base;
  const isBrand = pathname === `${base}/brand` || pathname?.startsWith(`${base}/brand/`);
  const isAssets = pathname === `${base}/assets` || pathname?.startsWith(`${base}/assets/`);
  const isContent = pathname === `${base}/content` || pathname?.startsWith(`${base}/content/`);

  return (
    <aside className="fixed inset-y-0 left-0 z-30 flex w-64 shrink-0 flex-col justify-between border-r border-outline-variant bg-surface-container-lowest">
      <div>
        <div className="flex flex-col gap-space-xs px-space-lg pt-margin pb-space-lg">
          <div className="flex items-center gap-space-sm">
            <div className="flex h-7 w-7 items-center justify-center rounded-control bg-primary font-headline text-headline-md font-bold text-on-primary">
              M
            </div>
            <span className="font-headline text-headline-md font-bold tracking-tight text-primary">MOS</span>
          </div>
          <span className="font-label text-label-sm uppercase tracking-wider text-on-surface-variant">
            Marketing Operating System
          </span>
        </div>

        <div className="px-space-lg pb-space-md">
          <div className="flex w-full items-center justify-between rounded-control bg-surface-container-low px-space-md py-space-sm text-left">
            <div className="flex min-w-0 flex-col pr-space-xs">
              <span className="font-label text-label-sm uppercase tracking-wider text-on-surface-variant">
                Workspace
              </span>
              <span className="truncate font-body text-body-md font-medium text-on-surface">{workspaceName}</span>
            </div>
          </div>
        </div>

        <nav className="flex flex-col gap-space-xs px-space-lg">
          <NavItem label="Command Center" icon={CommandCenterIcon} href={base} active={isCommandCenter} />
          <NavItem label="Intelligence" icon={IntelligenceIcon} />
          <NavItem
            label="Content Studio"
            icon={ContentStudioIcon}
            href={`${base}/content`}
            active={isContent}
          />
          <NavItem label="Content Calendar" icon={CalendarIcon} />
          <NavItem label="Social Analytics" icon={AnalyticsIcon} />
          <NavItem label="Campaigns" icon={CampaignsIcon} />
          <NavItem label="Performance Marketing" icon={PerformanceIcon} />
          <NavItem label="Assets" icon={AssetsIcon} href={`${base}/assets`} active={isAssets} />
          <NavItem label="Brand" icon={BrandIcon} href={`${base}/brand`} active={isBrand} />
          <NavItem label="Automation" icon={AutomationIcon} />
          <NavItem label="Settings" icon={SettingsIcon} />
        </nav>
      </div>

      <div className="p-space-lg">
        <div className="flex flex-col gap-space-sm rounded-card bg-surface-container-low p-space-md">
          <p className="font-body text-body-sm font-medium leading-relaxed text-on-surface">
            One marketer. One system. A bigger tomorrow.
          </p>
          <div className="flex items-center justify-between pt-space-xs">
            <span className="font-label text-label-sm font-semibold text-on-surface-variant">MOS v1.0</span>
            <span className="flex items-center gap-space-xs">
              <span className="h-1.5 w-1.5 rounded-full bg-on-tertiary-container" />
              <span className="font-label text-label-sm font-medium text-on-tertiary-container">
                Systems synced
              </span>
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
