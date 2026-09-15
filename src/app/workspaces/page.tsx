import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { listWorkspacesForCurrentUser } from "@/server/services/workspaces";

import { createWorkspaceAction, signOutAction } from "./actions";

export default async function WorkspacesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth/sign-in");
  }

  const workspaces = await listWorkspacesForCurrentUser();

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 px-4 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Workspaces</h1>
        <form action={signOutAction}>
          <button type="submit" className="text-sm underline">
            Sign out
          </button>
        </form>
      </div>

      {workspaces.length === 0 ? (
        <p className="text-sm text-gray-600">You don&apos;t belong to any workspace yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {workspaces.map((workspace) => (
            <li key={workspace.id} className="rounded border border-gray-200 px-3 py-2">
              {workspace.name}
              <span className="ml-2 text-xs text-gray-500">/{workspace.slug}</span>
            </li>
          ))}
        </ul>
      )}

      <form action={createWorkspaceAction} className="flex flex-col gap-3">
        <label className="text-sm font-medium" htmlFor="name">
          Create a new workspace
        </label>
        <input
          id="name"
          name="name"
          required
          placeholder="Acme Marketing"
          className="rounded border border-gray-300 px-3 py-2"
        />
        <button type="submit" className="rounded bg-black px-3 py-2 text-white">
          Create workspace
        </button>
      </form>
    </main>
  );
}
