// Shared between a test and the mocked @supabase/ssr client (see
// supabase-ssr.ts): lets an integration test choose which signed-in test
// user's access token the RLS-scoped server client authenticates as,
// without needing to fake Supabase's cookie encoding.
let currentAccessToken: string | null = null;

export function setTestAccessToken(token: string | null): void {
  currentAccessToken = token;
}

export function getTestAccessToken(): string | null {
  return currentAccessToken;
}
