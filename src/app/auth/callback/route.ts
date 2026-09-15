import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

const DEFAULT_REDIRECT_PATH = "/workspaces";

function sanitizeNextPath(rawNext: string | null): string {
  if (!rawNext) {
    return DEFAULT_REDIRECT_PATH;
  }

  // Only allow a same-origin relative path: must start with a single "/",
  // and must not be a protocol-relative ("//host"), backslash-based
  // ("/\host"), or absolute URL, and must not contain whitespace/control
  // characters or an embedded scheme that could be used to change the
  // effective redirect origin.
  const isSameOriginPath =
    rawNext.startsWith("/") &&
    !rawNext.startsWith("//") &&
    !rawNext.startsWith("/\\") &&
    !/[\s\x00-\x1f\\]/.test(rawNext) &&
    !rawNext.includes("://");

  return isSameOriginPath ? rawNext : DEFAULT_REDIRECT_PATH;
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = sanitizeNextPath(searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/auth/sign-in`);
}
