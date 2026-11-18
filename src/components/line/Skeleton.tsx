import { cn } from "@/lib/utils";

/**
 * Loading placeholders.
 *
 * A skeleton is worth having only when it has the shape of the thing it stands
 * in for: the eye should be able to start reading the page before the data
 * lands, and the layout must not jump when it does. That is the whole rule this
 * file follows — every variant below mirrors a real component's box model, and
 * the sizes come from that component, not from round numbers.
 *
 * It is `aria-hidden` and the region around it carries the live region: a screen
 * reader should hear "loading", not twenty decorative boxes. The shimmer stops
 * for anyone who asked for reduced motion; the shape stays, because the shape is
 * the information.
 *
 * Where each one is used is documented on the component that owns the data:
 * ServerList, ServerDetail, ProfileScreen, WardrobeScreen, SettingsScreen and
 * the sign-in gate.
 */

/** One grey bar. The primitive every variant is built from. */
export function SkeletonBlock({
  className,
  /** Text bars are thinner and rounder than boxes; both are the same shimmer. */
  rounded = "sm",
}: {
  className?: string;
  rounded?: "sm" | "md" | "full";
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "line-skeleton block",
        rounded === "full" && "rounded-full",
        rounded === "md" && "rounded-[8px]",
        rounded === "sm" && "rounded-[5px]",
        className,
      )}
    />
  );
}

/**
 * A server card: banner, icon, name, version, two lines of description and the
 * version line — the same stack `ServerCard` renders and with the same rhythm,
 * so the grid does not reflow when the catalogue arrives.
 */
export function SkeletonServerCard({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      data-line-glass="frost"
      className={cn(
        "flex flex-col gap-3 rounded-[var(--radius-item)] p-0",
        className,
      )}
    >
      {/* Banner: 96px tall, the card's own height. */}
      <SkeletonBlock className="h-24 w-full" rounded="md" />
      <div className="flex flex-col gap-3 px-4 pb-4">
        <div className="flex items-center gap-2.5">
          {/* The 32px icon tile, then the name and version beside it. */}
          <SkeletonBlock className="size-8 shrink-0" rounded="md" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <SkeletonBlock className="h-3.5 w-2/5" />
            <SkeletonBlock className="h-2.5 w-1/4" />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <SkeletonBlock className="h-2.5 w-full" />
          <SkeletonBlock className="h-2.5 w-4/5" />
        </div>
        <SkeletonBlock className="h-2.5 w-1/3" />
      </div>
    </div>
  );
}

/** The catalogue: the same three-column grid `ServerList` uses. */
export function SkeletonServerGrid({ count = 6 }: { count?: number }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
    >
      {Array.from({ length: count }, (_, index) => (
        <SkeletonServerCard key={index} />
      ))}
    </div>
  );
}

/** Settings: a heading, then the stacked sections with their controls. */
export function SkeletonSettings() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex flex-col gap-7"
    >
      <div className="flex flex-col gap-2">
        <SkeletonBlock className="h-6 w-40" />
        <SkeletonBlock className="h-3 w-3/4" />
      </div>
      {[0, 1, 2].map((section) => (
        <div key={section} className="flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <SkeletonBlock className="size-8 shrink-0" rounded="md" />
            <div className="flex flex-1 flex-col gap-1.5">
              <SkeletonBlock className="h-3.5 w-1/4" />
              <SkeletonBlock className="h-2.5 w-2/5" />
            </div>
          </div>
          <SkeletonBlock className="h-9 w-full" rounded="md" />
        </div>
      ))}
    </div>
  );
}

/**
 * The account page: the 3D viewer's box on the left, the session facts on the
 * right. The box is a square because the viewer is one — a resized canvas after
 * load is exactly the jump skeletons exist to prevent.
 */
export function SkeletonProfile() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex flex-col gap-6 sm:flex-row sm:items-start"
    >
      <SkeletonBlock
        className="aspect-square w-full max-w-[260px]"
        rounded="md"
      />
      <div className="flex flex-1 flex-col gap-4">
        <SkeletonBlock className="h-6 w-1/3" />
        <SkeletonBlock className="h-3 w-1/4" />
        <div className="flex flex-col gap-2">
          <SkeletonBlock className="h-3 w-full" />
          <SkeletonBlock className="h-3 w-5/6" />
        </div>
        <SkeletonBlock className="h-9 w-36" rounded="md" />
      </div>
    </div>
  );
}

/**
 * The wardrobe: the upload card on the left and the history rows on the right,
 * matching `WardrobeScreen`'s two-column layout.
 */
export function SkeletonWardrobe() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex flex-col gap-6 lg:flex-row lg:items-start"
    >
      <div className="flex w-full flex-col gap-3 lg:max-w-sm">
        <SkeletonBlock className="h-4 w-32" />
        <SkeletonBlock className="h-44 w-full" rounded="md" />
        <SkeletonBlock className="h-9 w-full" rounded="md" />
      </div>
      <div className="flex flex-1 flex-col gap-2">
        <SkeletonBlock className="h-4 w-28" />
        {[0, 1, 2].map((row) => (
          <div
            key={row}
            className="border-border/40 flex items-center gap-3 rounded-[var(--radius-control)] border p-2"
          >
            <SkeletonBlock className="size-10 shrink-0" rounded="md" />
            <div className="flex flex-1 flex-col gap-1.5">
              <SkeletonBlock className="h-3 w-1/3" />
              <SkeletonBlock className="h-2.5 w-1/5" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The sign-in card: the tab trough, two labelled fields and the button. Used
 * while the provider config is still arriving, so the player sees where the
 * form will be instead of a centred spinner on an empty page.
 */
export function SkeletonAuthCard() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex w-full max-w-[380px] flex-col gap-4"
    >
      <SkeletonBlock className="h-12 w-12 self-center" rounded="md" />
      <SkeletonBlock className="mx-auto h-6 w-2/5" />
      <SkeletonBlock className="mx-auto mb-2 h-3 w-3/5" />
      <div
        data-line-glass
        className="flex flex-col gap-4 rounded-[var(--radius-panel)] p-6"
      >
        <SkeletonBlock className="h-7 w-full" rounded="md" />
        <div className="flex flex-col gap-1.5">
          <SkeletonBlock className="h-3 w-12" />
          <SkeletonBlock className="h-9 w-full" rounded="md" />
        </div>
        <div className="flex flex-col gap-1.5">
          <SkeletonBlock className="h-3 w-14" />
          <SkeletonBlock className="h-9 w-full" rounded="md" />
        </div>
        <SkeletonBlock className="h-10 w-full" rounded="md" />
      </div>
    </div>
  );
}

/**
 * The build history dialog's rows: version, size, date and the rollback button.
 * Rendered in place of the list while `lineApi.history` is in flight.
 */
export function SkeletonHistoryRows({ rows = 3 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex flex-col gap-2"
    >
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="border-border/40 flex items-center gap-3 rounded-[var(--radius-control)] border p-3"
        >
          <div className="flex flex-1 flex-col gap-1.5">
            <SkeletonBlock className="h-3 w-24" />
            <SkeletonBlock className="h-2.5 w-40" />
          </div>
          <SkeletonBlock className="h-8 w-24" rounded="md" />
        </div>
      ))}
    </div>
  );
}
