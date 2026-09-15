/**
 * Hand-authored types for the MVP-0 Foundation schema.
 *
 * These cover only the tables/enums/functions introduced by
 * `supabase/migrations/20260915063156_foundation.sql` and
 * `20260915063158_storage_foundation.sql`. Once a live Supabase project
 * exists, prefer replacing this file with the output of
 * `supabase gen types typescript` and extending it per-migration.
 *
 * Shape follows @supabase/postgrest-js's `GenericSchema` contract
 * (Tables need Row/Insert/Update/Relationships, Functions need
 * Args/Returns) — deviating from it silently degrades every `.from()`/
 * `.rpc()` call on this client to `never`, with no type error at the
 * `createClient<Database>()` call site itself.
 *
 * Row/Insert/Update types below are declared with `type`, not
 * `interface`: TypeScript's structural `extends Record<string, unknown>`
 * check (which `GenericTable` relies on) only succeeds for object type
 * aliases, not for `interface` declarations, even though both describe
 * the same shape.
 */

export type WorkspaceRole = "owner" | "admin" | "marketer" | "viewer";

export type Profile = {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
};

export type Workspace = {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type WorkspaceMember = {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
  updated_at: string;
};

export type AuditLog = {
  id: string;
  workspace_id: string;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: Partial<Profile> & Pick<Profile, "id">;
        Update: Partial<Pick<Profile, "display_name" | "avatar_url">>;
        Relationships: [];
      };
      workspaces: {
        Row: Workspace;
        Insert: Partial<Workspace> & Pick<Workspace, "name" | "slug" | "owner_id">;
        Update: Partial<Pick<Workspace, "name" | "archived_at">>;
        Relationships: [];
      };
      workspace_members: {
        Row: WorkspaceMember;
        Insert: Partial<WorkspaceMember> &
          Pick<WorkspaceMember, "workspace_id" | "user_id" | "role">;
        Update: Partial<Pick<WorkspaceMember, "role">>;
        Relationships: [];
      };
      audit_logs: {
        Row: AuditLog;
        Insert: Partial<AuditLog> & Pick<AuditLog, "workspace_id" | "action" | "entity_type">;
        Update: Partial<AuditLog>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      create_workspace: {
        Args: { p_name: string; p_slug: string };
        Returns: Workspace;
      };
      log_audit_event: {
        Args: {
          p_workspace_id: string;
          p_action: string;
          p_entity_type: string;
          p_entity_id?: string | null;
          p_metadata?: Record<string, unknown>;
        };
        Returns: AuditLog;
      };
      is_workspace_member: {
        Args: { p_workspace_id: string };
        Returns: boolean;
      };
      is_workspace_admin: {
        Args: { p_workspace_id: string };
        Returns: boolean;
      };
      get_workspace_role: {
        Args: { p_workspace_id: string };
        Returns: WorkspaceRole;
      };
    };
  };
}
