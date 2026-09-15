import Link from "next/link";
import type { ComponentType, SVGProps } from "react";

type NavItemProps = {
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  href?: string;
  active?: boolean;
};

/**
 * A sidebar nav entry. Renders as a real link only when `href` is given
 * (i.e. its screen has been implemented). Otherwise renders as a visually
 * present but non-interactive placeholder — the module exists in the
 * product's shape (matching the Stitch reference) without implying it is
 * currently available.
 */
export function NavItem({ label, icon: IconComponent, href, active = false }: NavItemProps) {
  const content = (
    <>
      <IconComponent className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
    </>
  );

  if (!href) {
    return (
      <span
        className="flex items-center gap-3 rounded-control px-space-md py-space-sm font-body text-body-md text-on-surface-variant/50"
        aria-disabled="true"
      >
        {content}
        <span className="ml-auto font-label text-label-sm text-on-surface-variant/50">Soon</span>
      </span>
    );
  }

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-3 rounded-control px-space-md py-space-sm font-body text-body-md transition-colors ${
        active
          ? "bg-primary font-medium text-on-primary"
          : "text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface"
      }`}
    >
      {content}
    </Link>
  );
}
