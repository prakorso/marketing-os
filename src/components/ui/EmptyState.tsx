import type { ReactNode } from "react";

type EmptyStateProps = {
  title: string;
  description?: string;
  action?: ReactNode;
};

/** Structural placeholder for a section with nothing to show yet — never used to imply fake data. */
export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-card border border-dashed border-outline-variant px-space-lg py-space-xl text-center">
      <p className="font-body text-body-md font-semibold text-on-surface">{title}</p>
      {description ? (
        <p className="max-w-md font-body text-body-sm text-on-surface-variant">{description}</p>
      ) : null}
      {action}
    </div>
  );
}
