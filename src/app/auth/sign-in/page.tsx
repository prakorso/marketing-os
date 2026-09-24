"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { createClient } from "@/lib/supabase/client";

import { requestMagicLink } from "./magic-link";

/**
 * Restores the intended Supabase email magic-link sign-in flow
 * (signInWithOtp), replacing the temporary signInAnonymously()
 * placeholder. See magic-link.ts for the pure, tested request logic;
 * src/app/auth/callback/route.ts (unchanged) already generically
 * exchanges the resulting code for a session and redirects to
 * /workspaces.
 */
export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"checking" | "idle" | "loading" | "sent" | "error">("checking");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled) return;
      if (session) {
        router.replace("/workspaces");
        router.refresh();
        return;
      }
      setStatus("idle");
    });

    return () => {
      cancelled = true;
    };
  }, [router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("loading");
    setErrorMessage("");

    const supabase = createClient();
    const { error } = await requestMagicLink(supabase, email, window.location.origin);

    if (error) {
      setStatus("error");
      setErrorMessage(error);
      return;
    }
    setStatus("sent");
  }

  if (status === "checking") {
    return null;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-4">
      <h1 className="text-xl font-semibold">Marketing OS</h1>

      {status === "sent" ? (
        <p className="text-sm text-gray-600">Check your email for a sign-in link.</p>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <p className="text-sm text-gray-600">Sign in with a magic link</p>
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="rounded border px-3 py-2"
          />
          <button
            type="submit"
            disabled={status === "loading"}
            className="rounded bg-black px-3 py-2 text-white disabled:opacity-50"
          >
            {status === "loading" ? "Sending..." : "Send magic link"}
          </button>
        </form>
      )}

      {status === "error" && <p className="text-sm text-red-600">{errorMessage}</p>}
    </main>
  );
}
