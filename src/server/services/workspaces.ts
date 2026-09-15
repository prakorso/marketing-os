import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { Workspace } from "@/types/database";

const POSTGRES_UNIQUE_VIOLATION = "23505";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "workspace";
}

/** Workspaces the current authenticated user is a member of (RLS-scoped). */
export async function listWorkspacesForCurrentUser(): Promise<Workspace[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspaces")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to list workspaces: ${error.message}`);
  }

  return data ?? [];
}

/**
 * Creates a workspace and its owner membership atomically via the
 * `create_workspace` RPC (see Database Architecture §2, Engineering
 * Blueprint §23 migration). Retries with a suffixed slug on collision.
 */
export async function createWorkspace(name: string): Promise<Workspace> {
  const supabase = await createClient();
  const baseSlug = slugify(name);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${Math.random().toString(36).slice(2, 7)}`;

    // No .single(): create_workspace returns one row directly (`returns
    // public.workspaces`, not SETOF), so the RPC result is already a
    // single object, not a set to narrow with .single().
    const { data, error } = await supabase.rpc("create_workspace", {
      p_name: name,
      p_slug: slug,
    });

    if (!error) {
      return data;
    }

    if (error.code !== POSTGRES_UNIQUE_VIOLATION) {
      throw new Error(`Failed to create workspace: ${error.message}`);
    }
  }

  throw new Error("Failed to create workspace: could not generate a unique slug");
}
