/**
 * Pure, framework-free magic-link request logic — split out from
 * page.tsx so it is testable with the existing plain-vitest-node setup
 * (this repo has no React component-testing harness; mirrors how
 * src/lib/analytics/ui-format.ts was split out as pure, testable
 * formatting helpers in MVP-5.11).
 *
 * Restores the intended Supabase email magic-link flow
 * (signInWithOtp), replacing the temporary signInAnonymously()
 * placeholder (see git history: "feat: add anonymous development
 * authentication"). Never touches a credential, secret, or token —
 * signInWithOtp takes only an email address and returns a generic
 * success/error result.
 */

/** Minimal structural type for what this module needs from a Supabase client — avoids depending on the full SupabaseClient<Database> generic just to send an OTP request. */
export type MagicLinkAuthClient = {
  auth: {
    signInWithOtp: (args: {
      email: string;
      options?: { emailRedirectTo?: string };
    }) => Promise<{ error: { message: string } | null }>;
  };
};

/**
 * The auth callback route (src/app/auth/callback/route.ts) already
 * generically exchanges any `code` param for a session and redirects to
 * `next` (defaulting to /workspaces) — unchanged by this module. No
 * `next` param is passed here: the callback's own default is exactly the
 * desired post-sign-in destination, so there is nothing to override.
 */
export function buildEmailRedirectTo(origin: string): string {
  return `${origin}/auth/callback`;
}

export type RequestMagicLinkResult = { error: string | null };

export async function requestMagicLink(
  supabase: MagicLinkAuthClient,
  email: string,
  origin: string,
): Promise<RequestMagicLinkResult> {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: buildEmailRedirectTo(origin) },
  });
  return { error: error?.message ?? null };
}
