"use client";

import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";

export default function WorkspaceError({ reset }: { error: Error; reset: () => void }) {
  return (
    <EmptyState
      title="Something went wrong loading this workspace"
      description="Try again, or head back to your workspace list."
      action={
        <Button variant="secondary" onClick={reset}>
          Try again
        </Button>
      }
    />
  );
}
