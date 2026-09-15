import type { HTMLAttributes } from "react";

type CardProps = HTMLAttributes<HTMLDivElement>;

/** Standard surface container — white panel, thin border, no shadow at rest. */
export function Card({ className = "", ...props }: CardProps) {
  return (
    <div
      className={`rounded-card border border-outline-variant bg-surface-container-lowest p-space-lg ${className}`}
      {...props}
    />
  );
}
