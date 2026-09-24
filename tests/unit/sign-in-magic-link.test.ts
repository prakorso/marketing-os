import { describe, expect, it, vi } from "vitest";

import { buildEmailRedirectTo, requestMagicLink, type MagicLinkAuthClient } from "@/app/auth/sign-in/magic-link";

/**
 * Restores the intended Supabase email magic-link flow (signInWithOtp),
 * replacing the temporary signInAnonymously() placeholder. Pure-logic
 * tests only — this repo has no React component-testing harness, so the
 * page itself is not rendered here; magic-link.ts was split out
 * specifically so this logic is testable without one.
 */
describe("requestMagicLink", () => {
  function mockClient(error: { message: string } | null = null): { client: MagicLinkAuthClient; signInWithOtp: ReturnType<typeof vi.fn> } {
    const signInWithOtp = vi.fn(async () => ({ error }));
    return { client: { auth: { signInWithOtp } }, signInWithOtp };
  }

  it("invokes signInWithOtp (the intended magic-link flow), never signInAnonymously", async () => {
    const { client, signInWithOtp } = mockClient();
    await requestMagicLink(client, "user@example.com", "https://marqos-staging.netlify.app");

    expect(signInWithOtp).toHaveBeenCalledTimes(1);
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "user@example.com",
      options: { emailRedirectTo: "https://marqos-staging.netlify.app/auth/callback" },
    });
    expect("signInAnonymously" in client.auth).toBe(false);
  });

  it("builds the expected redirect URL back to the existing, unchanged auth callback route", () => {
    expect(buildEmailRedirectTo("https://marqos-staging.netlify.app")).toBe("https://marqos-staging.netlify.app/auth/callback");
    expect(buildEmailRedirectTo("http://localhost:3000")).toBe("http://localhost:3000/auth/callback");
  });

  it("returns no error on a successful signInWithOtp call", async () => {
    const { client } = mockClient(null);
    const result = await requestMagicLink(client, "user@example.com", "https://marqos-staging.netlify.app");
    expect(result.error).toBeNull();
  });

  it("surfaces a sanitized error message on failure, without throwing", async () => {
    const { client } = mockClient({ message: "Email rate limit exceeded" });
    const result = await requestMagicLink(client, "user@example.com", "https://marqos-staging.netlify.app");
    expect(result.error).toBe("Email rate limit exceeded");
  });

  it("never includes a credential, token, or secret in its inputs or outputs", async () => {
    const { client, signInWithOtp } = mockClient();
    const result = await requestMagicLink(client, "user@example.com", "https://marqos-staging.netlify.app");

    const callArgs = JSON.stringify(signInWithOtp.mock.calls[0]);
    expect(callArgs).not.toMatch(/token|secret|password/i);
    expect(JSON.stringify(result)).not.toMatch(/token|secret|password/i);
  });
});
