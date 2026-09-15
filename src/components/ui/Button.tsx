import type { ButtonHTMLAttributes } from "react";

type ButtonVariant = "primary" | "secondary" | "tertiary";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-on-primary hover:opacity-90 disabled:bg-surface-container-high disabled:text-on-surface-variant",
  secondary:
    "bg-surface-container-lowest text-on-surface border border-outline-variant hover:bg-surface-container-low disabled:text-on-surface-variant",
  tertiary:
    "bg-transparent text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface disabled:text-outline-variant",
};

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

export function Button({ variant = "primary", className = "", ...props }: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-control px-3.5 py-2 font-label text-label-md font-medium tracking-wide transition disabled:cursor-not-allowed ${VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    />
  );
}
