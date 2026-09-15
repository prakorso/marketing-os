import type { ReactNode } from "react";

type PageHeaderProps = {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: ReactNode;
};

/** Breadcrumb/eyebrow + title + description + actions row, reused at the top of every page. */
export function PageHeader({ eyebrow, title, description, actions }: PageHeaderProps) {
  return (
    <section className="flex flex-col gap-space-md border-b border-outline-variant pb-space-lg md:flex-row md:items-center md:justify-between">
      <div>
        <span className="rounded-control border border-outline-variant bg-surface-container-low px-space-sm py-0.5 font-label text-label-sm font-semibold uppercase tracking-wider text-on-surface-variant">
          {eyebrow}
        </span>
        <h1 className="mt-space-sm font-headline text-headline-lg font-bold tracking-tight text-on-surface">
          {title}
        </h1>
        {description ? (
          <p className="mt-space-xs font-body text-body-sm text-on-surface-variant">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-space-sm">{actions}</div> : null}
    </section>
  );
}
