"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { createClient } from "@/lib/supabase/client";

// TEMPORARY DEV-ONLY AUTH: parks email/magic-link sign-in while we debug
// Supabase email delivery. Uses Supabase Anonymous Sign-In so we still get a
// real authenticated Supabase user (RLS-compatible) without SMTP. Restore
// the signInWithOtp() flow below when email auth is ready again.
export default function SignInPage() {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  async function handleContinue() {
    setStatus("loading");
    setErrorMessage("");

    const supabase = createClient();

    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (session) {
      router.replace("/workspaces");
      router.refresh();
      return;
    }

    const { error } = await supabase.auth.signInAnonymously();

    if (error) {
      setStatus("error");
      setErrorMessage(error.message);
      return;
    }

    router.replace("/workspaces");
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-4">
      <h1 className="text-xl font-semibold">Marketing OS</h1>
      <p className="text-sm text-gray-600">Development access</p>

      <button
        type="button"
        onClick={handleContinue}
        disabled={status === "loading"}
        className="rounded bg-black px-3 py-2 text-white disabled:opacity-50"
      >
        {status === "loading" ? "Continuing..." : "Continue"}
      </button>

      {status === "error" && <p className="text-sm text-red-600">{errorMessage}</p>}
    </main>
  );
}
