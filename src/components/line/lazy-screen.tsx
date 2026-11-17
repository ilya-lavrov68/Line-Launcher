import {
  Component,
  lazy,
  Suspense,
  type ComponentType,
  type ReactNode,
} from "react";

/**
 * A screen that is not part of the startup bundle.
 *
 * Why this exists: the window opens on the greeting and then on the sign-in
 * page or the catalogue. Everything else — settings, the wardrobe (with its 3D
 * viewer and `skinview3d`), the account page — is two clicks away, and pulling
 * it into the first chunk meant the player waited for a form they had not
 * opened. Each of those now arrives as its own chunk, requested the first time
 * its screen is shown.
 *
 * Two properties matter, and both are the reason this is a helper rather than a
 * bare `lazy()` in the shell:
 *
 *  1. **No flash of nothing.** A dynamic import resolves quickly from the local
 *     bundle, but it *is* asynchronous. The fallback is the panel's own
 *     geometry — a quiet loading block on the glass — so the swap is a fill-in,
 *     not a blank frame.
 *  2. **Failures are honest.** A chunk that will not load (a corrupted install,
 *     a dev server that went away) must not leave a permanent blank panel. The
 *     boundary says what happened and offers nothing fake: the section switch
 *     will retry the import on the next visit.
 */
export function lazyScreen<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
) {
  const Lazy = lazy(load) as unknown as ComponentType<P>;
  return function LazyScreen(props: P) {
    return (
      <Suspense fallback={<ScreenLoading />}>
        <ChunkBoundary>
          <Lazy {...props} />
        </ChunkBoundary>
      </Suspense>
    );
  };
}

/**
 * The same quiet block the skeleton uses, so a lazily-loaded screen waits in the
 * shape of the panel instead of in a different design. Three bars, not a
 * spinner: the content that is coming is text, and its box is already sized.
 */
function ScreenLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex w-full flex-col gap-3 py-2"
    >
      <span className="line-skeleton h-6 w-40 rounded-[5px]" />
      <span className="line-skeleton h-3 w-3/4 rounded-[5px]" />
      <span className="line-skeleton h-3 w-1/2 rounded-[5px]" />
      <span className="sr-only">Загрузка…</span>
    </div>
  );
}

class ChunkBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn("[screen] chunk failed to load:", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <p
        role="alert"
        className="text-destructive px-2 py-6 text-xs leading-relaxed"
      >
        Не удалось загрузить раздел. Откройте его ещё раз или перезапустите
        лаунчер.
      </p>
    );
  }
}
