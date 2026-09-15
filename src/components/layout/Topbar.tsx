import { signOutAction } from "@/app/workspaces/actions";
import { Button } from "@/components/ui/Button";

type TopbarProps = {
  userLabel: string;
};

/**
 * Global header. Intentionally omits the search bar and date-range picker
 * shown in the Stitch reference — neither has any backend yet, and a
 * non-functional search/filter control would imply capability that
 * doesn't exist. "Create" is a disabled placeholder for the same reason:
 * no domain (Brand/Content/Assets) has a create flow wired up in this
 * phase. Sign-out is real, reusing the existing auth Server Action.
 */
export function Topbar({ userLabel }: TopbarProps) {
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-outline-variant bg-surface-container-lowest px-margin-lg">
      <div />
      <div className="flex items-center gap-space-lg">
        <Button variant="secondary" disabled title="Available once a content domain is implemented">
          + Create
        </Button>
        <form action={signOutAction} className="flex items-center gap-space-sm border-l border-outline-variant pl-space-md">
          <span className="hidden font-body text-body-sm font-semibold text-on-surface lg:inline">{userLabel}</span>
          <Button type="submit" variant="tertiary">
            Sign out
          </Button>
        </form>
      </div>
    </header>
  );
}
