import type { ReactNode } from "react";

type BadgeVariant = "neutral" | "active" | "alert";

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  neutral: "bg-surface-container-low text-on-surface-variant border-outline-variant",
  active: "bg-surface-container-low text-on-tertiary-container border-outline-variant",
  alert: "bg-error-container text-on-error-container border-error-container",
};

type BadgeProps = {
  variant?: BadgeVariant;
  children: ReactNode;
};

/** Rectangular status chip — no pill shapes, per the Executive Precision design system. */
export function Badge({ variant = "neutral", children }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-control border px-1.5 py-0.5 font-label text-label-sm font-semibold uppercase tracking-wide ${VARIANT_CLASSES[variant]}`}
    >
      {children}
    </span>
  );
}
