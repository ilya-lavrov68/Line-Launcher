import { useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  X,
} from "@/components/ui/icons";
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

/** A stable, directly navigable manual for first-time players. */
export default function LauncherTour({ onFinish }: LauncherTourProps) {
  const t = useT();
  const [page, setPage] = useState(0);
  const [playing, setPlaying] = useState(false);
  const current = PAGES[page];
  const steps = t(current.body)
    .split("\n")
    .map((step) => step.trim())
    .filter(Boolean);

  useEffect(() => {
    setPlaying(false);
  }, [page]);

  const goToPage = (index: number) => {
    setPage(Math.max(0, Math.min(PAGES.length - 1, index)));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onFinish()}>
      <DialogContent
        showCloseButton={false}
        data-line-glass="guidebook"
        overlayClassName="bg-black/60 supports-backdrop-filter:backdrop-blur-xl"
        className="grid h-[min(820px,calc(100dvh-2rem))] max-h-none w-[min(1540px,calc(100vw-2rem))] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-none bg-transparent p-4 shadow-none ring-0 sm:max-w-none sm:p-7"
      >
        <DialogHeader className="relative min-h-12 shrink-0 justify-center pr-12 pb-4 sm:pb-5">
          <DialogTitle id="launcher-tour-title" className="text-lg sm:text-xl">
            {t("tour.title")}
          </DialogTitle>
          <DialogDescription className="max-w-3xl text-sm leading-relaxed">
            {t("tour.intro")}
          </DialogDescription>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onFinish}
            aria-label={t("tour.skip")}
            title={t("tour.skip")}
            className="absolute top-0 right-0"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </DialogHeader>

        <div className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1.12fr)_minmax(0,0.88fr)] items-center gap-5 sm:gap-8">
          <figure
            data-testid="launcher-tour-media"
            className="relative m-0 aspect-video min-w-0 overflow-hidden"
          >
            <img
              key={`${current.gif}-${playing ? "playing" : "poster"}`}
              src={playing ? current.gif : current.poster}
              alt={t(current.alt)}
              width={1920}
              height={1080}
              className="block size-full object-contain"
              draggable={false}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t(
                playing ? "tour.pauseAnimation" : "tour.playAnimation",
              )}
              aria-pressed={playing}
              onClick={() => setPlaying((value) => !value)}
              className="absolute bottom-2 left-2 bg-black/60 text-white hover:bg-black/80 hover:text-white focus-visible:bg-black/80 focus-visible:text-white"
            >
              {playing ? (
                <Pause className="size-4" aria-hidden="true" />
              ) : (
                <Play className="size-4" aria-hidden="true" />
              )}
            </Button>
          </figure>

          <article
            data-testid="launcher-tour-copy"
            className="min-h-0 min-w-0 overflow-y-auto py-2"
            aria-live="polite"
            aria-labelledby="launcher-tour-page-title"
          >
            <h2
              id="launcher-tour-page-title"
              className="font-heading text-xl leading-tight font-semibold sm:text-2xl"
            >
              {t(current.title)}
            </h2>
            <ol className="text-foreground/90 mt-5 list-decimal space-y-3 pl-5 text-sm leading-relaxed sm:text-[15px]">
              {steps.map((step, index) => (
                <li key={`${page}-${index}`} className="pl-1">
                  {step}
                </li>
              ))}
            </ol>
          </article>
        </div>

        <footer className="flex min-w-0 items-center gap-2 pt-5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={page === 0}
            onClick={() => goToPage(page - 1)}
            aria-label={t("tour.previous")}
            title={t("tour.previous")}
            className="shrink-0"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </Button>
          <nav
            data-testid="launcher-tour-step-nav"
            role="tablist"
            aria-label={t("tour.choose")}
            className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
          >
            {PAGES.map((item, index) => (
              <button
                key={item.title}
                type="button"
                role="tab"
                aria-selected={page === index}
                aria-current={page === index ? "page" : undefined}
                onClick={() => goToPage(index)}
                className={`focus-visible:ring-ring min-h-9 shrink-0 px-2 text-left text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none sm:flex-1 sm:px-3 sm:text-[13px] ${
                  page === index
                    ? "text-foreground font-semibold"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <span className="whitespace-nowrap">{t(item.title)}</span>
              </button>
            ))}
          </nav>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={page === PAGES.length - 1}
            onClick={() => goToPage(page + 1)}
            aria-label={t("tour.next")}
            title={t("tour.next")}
            className="shrink-0"
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
