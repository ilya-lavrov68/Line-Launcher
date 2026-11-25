import { useEffect, useState } from "react";
import { Pause, Play, X } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/lib/line/i18n";

const PAGES = [
  {
    title: "tour.catalogTitle",
    body: "tour.catalogBody",
    alt: "tour.catalogAlt",
    gif: "/guidebook/servers.gif",
    poster: "/guidebook/servers.png",
  },
  {
    title: "tour.serverTitle",
    body: "tour.serverBody",
    alt: "tour.serverAlt",
    gif: "/guidebook/server-actions.gif",
    poster: "/guidebook/server-actions.png",
  },
  {
    title: "tour.navTitle",
    body: "tour.navBody",
    alt: "tour.navAlt",
    gif: "/guidebook/navigation.gif",
    poster: "/guidebook/navigation.png",
  },
  {
    title: "tour.wardrobeTitle",
    body: "tour.wardrobeBody",
    alt: "tour.wardrobeAlt",
    gif: "/guidebook/wardrobe.gif",
    poster: "/guidebook/wardrobe.png",
  },
  {
    title: "tour.accountTitle",
    body: "tour.accountBody",
    alt: "tour.accountAlt",
    gif: "/guidebook/account.gif",
    poster: "/guidebook/account.png",
  },
  {
    title: "tour.settingsTitle",
    body: "tour.settingsBody",
    alt: "tour.settingsAlt",
    gif: "/guidebook/settings.gif",
    poster: "/guidebook/settings.png",
  },
] as const;

interface LauncherTourProps {
  onFinish: () => void;
}

/** A searchable-at-a-glance, directly navigable guide for first-time players. */
export default function LauncherTour({ onFinish }: LauncherTourProps) {
  const t = useT();
  const [page, setPage] = useState(0);
  const [playing, setPlaying] = useState(false);
  const current = PAGES[page];

  useEffect(() => {
    setPlaying(false);
  }, [page]);

  return (
    <Dialog open onOpenChange={(open) => !open && onFinish()}>
      <DialogContent
        showCloseButton={false}
        overlayClassName="bg-black/30 supports-backdrop-filter:backdrop-blur-sm"
        className="max-h-[calc(100dvh-1.5rem)] max-w-[calc(100vw-1.5rem)] gap-0 overflow-hidden p-0 sm:max-h-[calc(100dvh-3rem)] sm:max-w-5xl"
      >
        <DialogHeader className="relative shrink-0 border-b px-5 py-4 pr-14 sm:px-7 sm:py-5">
          <DialogTitle id="launcher-tour-title" className="text-lg sm:text-xl">
            {t("tour.title")}
          </DialogTitle>
          <DialogDescription className="max-w-2xl leading-relaxed">
            {t("tour.intro")}
          </DialogDescription>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onFinish}
            aria-label={t("tour.skip")}
            title={t("tour.skip")}
            className="absolute top-3 right-3"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[minmax(170px,0.3fr)_minmax(0,1fr)]">
          <nav
            aria-label={t("tour.choose")}
            className="border-border/70 flex gap-2 overflow-x-auto border-b p-3 sm:flex-col sm:overflow-y-auto sm:border-r sm:border-b-0 sm:p-4"
          >
            {PAGES.map((item, index) => (
              <button
                key={item.title}
                type="button"
                aria-current={page === index ? "page" : undefined}
                onClick={() => setPage(index)}
                className={`focus-visible:ring-ring flex min-h-9 shrink-0 items-center rounded-lg px-3 py-1.5 text-left text-[13px] transition-colors focus-visible:ring-2 focus-visible:outline-none sm:w-full ${
                  page === index
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                }`}
              >
                <span className="whitespace-nowrap sm:whitespace-normal">
                  {t(item.title)}
                </span>
              </button>
            ))}
          </nav>

          <section
            className="min-h-0 min-w-0 overflow-y-auto p-4 sm:p-6"
            aria-live="polite"
          >
            <article className="mx-auto flex w-full max-w-3xl flex-col gap-3">
              <h2 className="font-heading text-base font-semibold sm:text-lg">
                {t(current.title)}
              </h2>
              <div className="bg-background/70 border-border/60 overflow-hidden rounded-lg border">
                <img
                  key={`${current.gif}-${playing ? "playing" : "poster"}`}
                  src={playing ? current.gif : current.poster}
                  alt={t(current.alt)}
                  className="mx-auto max-h-[min(26dvh,360px)] w-full object-contain"
                  draggable={false}
                />
              </div>
              <div className="flex min-h-9 items-center justify-between gap-3">
                <p className="text-muted-foreground min-w-0 text-sm leading-relaxed">
                  {t(current.body)}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={t(
                    playing ? "tour.pauseAnimation" : "tour.playAnimation",
                  )}
                  aria-pressed={playing}
                  onClick={() => setPlaying((value) => !value)}
                  className="shrink-0"
                >
                  {playing ? (
                    <Pause className="size-4" aria-hidden="true" />
                  ) : (
                    <Play className="size-4" aria-hidden="true" />
                  )}
                  {t(playing ? "tour.pauseAnimation" : "tour.playAnimation")}
                </Button>
              </div>
            </article>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
