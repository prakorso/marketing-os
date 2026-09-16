import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/AppShell";
import { createClient } from "@/lib/supabase/server";
import { getWorkspaceBySlug } from "@/server/services/workspaces";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth/sign-in");
  }

  // getWorkspaceBySlug is RLS-scoped: a missing workspace and a workspace
  // the user isn't a member of both resolve to null here. That's correct —
  // RLS already collapsed the distinction, so the redirect below is a UX
  // convenience, not the security boundary (Engineering Blueprint §8).
  const workspace = await getWorkspaceBySlug(slug);

  if (!workspace) {
    redirect("/workspaces");
  }

  return (
    <AppShell workspaceName={workspace.name} workspaceSlug={workspace.slug} userLabel={user.email ?? "Signed in"}>
      {children}
    </AppShell>
  );
}
