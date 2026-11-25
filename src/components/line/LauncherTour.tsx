import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import { Pause, Play, X } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/line/i18n";

const PAGES = [
  {
    title: "tour.navTitle",
    body: "tour.navBody",
    gif: "/guidebook/navigation.gif",
    poster: "/guidebook/navigation.png",
    alt: "tour.navTitle",
  },
  {
    title: "tour.catalogTitle",
    body: "tour.catalogBody",
    gif: "/guidebook/servers.gif",
    poster: "/guidebook/servers.png",
    alt: "tour.catalogTitle",
  },
  {
    title: "tour.serverTitle",
    body: "tour.serverBody",
    gif: "/guidebook/server-actions.gif",
    poster: "/guidebook/server-actions.png",
    alt: "tour.serverTitle",
  },
  {
    title: "tour.wardrobeTitle",
    body: "tour.wardrobeBody",
    gif: "/guidebook/wardrobe.gif",
    poster: "/guidebook/wardrobe.png",
    alt: "tour.wardrobeTitle",
  },
  {
    title: "tour.accountTitle",
    body: "tour.accountBody",
    gif: "/guidebook/account.gif",
    poster: "/guidebook/account.png",
    alt: "tour.accountTitle",
  },
  {
    title: "tour.settingsTitle",
    body: "tour.settingsBody",
    gif: "/guidebook/settings.gif",
    poster: "/guidebook/settings.png",
    alt: "tour.settingsTitle",
  },
] as const;

interface LauncherTourProps {
  onFinish: () => void;
}

/** A page-by-page illustrated guide, shown after the player's first sign-in. */
export default function LauncherTour({ onFinish }: LauncherTourProps) {
  const t = useT();
  const reducedMotion = useReducedMotion();
  const [page, setPage] = useState(0);
  const [playback, setPlayback] = useState<{
    page: number;
    playing: boolean;
  } | null>(null);
  const current = PAGES[page];
  const isLastPage = page === PAGES.length - 1;
  const isPlaying =
    playback?.page === page ? playback.playing : reducedMotion === false;

  useEffect(() => {
    if (reducedMotion === null) return;
    setPlayback({ page, playing: !reducedMotion });
  }, [page, reducedMotion]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") onFinish();
      if (event.key === "ArrowRight")
        setPage((value) => Math.min(value + 1, PAGES.length - 1));
      if (event.key === "ArrowLeft") setPage((value) => Math.max(value - 1, 0));
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [onFinish]);

  return (
    <AnimatePresence>
      <m.div
        className="bg-background/85 fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto p-3 backdrop-blur-md sm:p-6"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <m.section
          role="dialog"
          aria-modal="true"
          aria-labelledby="launcher-tour-title"
          className="bg-card text-card-foreground border-border my-auto w-full max-w-4xl overflow-hidden rounded-2xl border shadow-2xl"
          initial={
            reducedMotion ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.985 }
          }
          animate={
            reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }
          }
          transition={
            reducedMotion
              ? { duration: 0.12 }
              : { type: "spring", stiffness: 260, damping: 25 }
          }
        >
          <header className="border-border/70 flex items-start justify-between gap-4 border-b px-5 py-4 sm:px-7">
            <div>
              <p className="text-primary mb-1 text-[11px] font-semibold tracking-[.16em] uppercase">
                {t("tour.progress", {
                  current: page + 1,
                  total: PAGES.length,
                })}
              </p>
              <h2 id="launcher-tour-title" className="text-xl font-semibold">
                {t(current.title)}
              </h2>
            </div>
            <button
              type="button"
              onClick={onFinish}
              aria-label={t("tour.skip")}
              title={t("tour.skip")}
              className="text-muted-foreground hover:text-foreground rounded-lg p-2 transition-colors"
            >
              <X className="size-4" />
            </button>
          </header>

          <AnimatePresence mode="wait">
            <m.div
              key={current.gif}
              className="px-4 pt-4 sm:px-7 sm:pt-6"
              initial={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 14 }}
              animate={reducedMotion ? { opacity: 1 } : { opacity: 1, x: 0 }}
              exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -14 }}
              transition={{ duration: reducedMotion ? 0.12 : 0.18 }}
            >
              <div className="bg-background/70 border-border/60 overflow-hidden rounded-xl border shadow-inner">
                <img
                  key={`${current.gif}-${isPlaying ? "playing" : "poster"}`}
                  src={isPlaying ? current.gif : current.poster}
                  alt={t(current.alt)}
                  className="aspect-[8/5] max-h-[min(56vh,500px)] w-full object-contain"
                  draggable={false}
                />
              </div>
              <div className="flex min-h-10 items-center justify-end pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={t(
                    isPlaying ? "tour.pauseAnimation" : "tour.playAnimation",
                  )}
                  aria-pressed={isPlaying}
                  aria-describedby={
                    !isPlaying ? "tour-animation-restart-hint" : undefined
                  }
                  onClick={() => setPlayback({ page, playing: !isPlaying })}
                >
                  {isPlaying ? (
                    <Pause className="size-4" aria-hidden="true" />
                  ) : (
                    <Play className="size-4" aria-hidden="true" />
                  )}
                  {t(isPlaying ? "tour.pauseAnimation" : "tour.playAnimation")}
                </Button>
                <span id="tour-animation-restart-hint" className="sr-only">
                  {t("tour.animationResumeHint")}
                </span>
              </div>
              <p className="text-muted-foreground min-h-14 px-1 pt-4 text-sm leading-relaxed sm:text-base">
                {t(current.body)}
              </p>
            </m.div>
          </AnimatePresence>

          <footer className="border-border/70 flex items-center justify-between gap-3 border-t px-4 py-4 sm:px-7">
            <Button
              variant="outline"
              onClick={() => setPage((value) => value - 1)}
              disabled={page === 0}
            >
              {t("tour.back")}
            </Button>
            <div className="flex items-center gap-1.5" aria-hidden="true">
              {PAGES.map((item, index) => (
                <span
                  key={item.gif}
                  className={`h-1.5 rounded-full transition-all ${index === page ? "bg-primary w-5" : "bg-muted-foreground/30 w-1.5"}`}
                />
              ))}
            </div>
            <Button
              onClick={() =>
                isLastPage ? onFinish() : setPage((value) => value + 1)
              }
            >
              {t(isLastPage ? "tour.done" : "tour.next")}
            </Button>
          </footer>
        </m.section>
      </m.div>
    </AnimatePresence>
  );
}
