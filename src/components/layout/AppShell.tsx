import type { ReactNode } from "react";

import { Sidebar } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";

type AppShellProps = {
  workspaceName: string;
  workspaceSlug: string;
  activePath: "command-center";
  userLabel: string;
  children: ReactNode;
};

/** Authenticated application chrome: sidebar + topbar + main content container. */
export function AppShell({ workspaceName, workspaceSlug, activePath, userLabel, children }: AppShellProps) {
  return (
    <div className="min-h-screen bg-background">
      <Sidebar workspaceName={workspaceName} workspaceSlug={workspaceSlug} activePath={activePath} />
      <div className="ml-64 flex min-h-screen flex-col">
        <Topbar userLabel={userLabel} />
        <main className="mx-auto w-full max-w-[1600px] flex-1 p-margin-lg">{children}</main>
      </div>
    </div>
  );
}
