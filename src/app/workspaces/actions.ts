"use server";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { createWorkspace } from "@/server/services/workspaces";

export async function createWorkspaceAction(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    throw new Error("Workspace name is required");
  }

  await createWorkspace(name);
  redirect("/workspaces");
}

export async function signOutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/auth/sign-in");
}
