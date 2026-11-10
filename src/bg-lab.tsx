import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { LazyMotion, MotionConfig, domAnimation } from "framer-motion";
import { MeshGradient, NeuroNoise } from "@paper-design/shaders-react";
import { Hazeglow, type GradientConfig } from "hazeglow";
import { GradientBackground } from "react-gradient-animation";
import "./index.css";
import "./brand/generated.css";
import ThemeProvider from "@/components/line/ThemeProvider";

/**
 * Review-only page: four animated backdrops behind the real shell.
 *
 * The launcher needs a colour on the page that is not a static gradient, so the
 * candidates are compared on the thing they will actually sit behind — a 60px
 * rail, the server cards and the action dock — instead of on a swatch.
 *
 * Never imported by the app. `?bg=mesh|orb|hazeglow|particles`.
 */

type BgId = "mesh" | "orb" | "hazeglow" | "particles";

const BACKDROPS: { id: BgId; name: string; note: string }[] = [
  {
    id: "mesh",
    name: "Mesh Gradient",
    note: "paper-design/shaders · Apache-2.0 · WebGL, четыре цветовых пятна",
  },
  {
    id: "orb",
    name: "Neuro Noise (орбы)",
    note: "paper-design/shaders · Apache-2.0 · WebGL, светящиеся сгустки",
  },
  {
    id: "hazeglow",
    name: "Hazeglow (mesh)",
    note: "hazeglow · MIT · WebGL2, шейдер с зерном, ноль зависимостей",
  },
  {
    id: "particles",
    name: "Canvas-градиент",
    note: "react-gradient-animation · MIT · 2D canvas, плывущие пятна, без WebGL",
  },
];

// The project's own colours: canvas, accent and the two haze steps that sit
// between them. Nothing new is invented for the backdrop.
const PALETTE = ["#08090c", "#0f3d2a", "#2fbf71", "#0d2a3d"];

const HAZE_CONFIG: GradientConfig = {
  version: 1,
  seed: 7,
  shape: "mesh",
  center: [0.5, 0.45],
  size: [0.95, 0.9],
  roundness: 0.7,
  softness: 0.7,
  rotation: 0,
  rampDirection: 0.9,
  angle: 90,
  warp: 0.12,
  warpScale: 1,
  palette: ["#08090c", "#0f3d2a", "#2fbf71", "#0d2a3d"],
  background: "#08090c",
  mesh: [
    [0.22, 0.3, "#2fbf71"],
    [0.72, 0.24, "#0d2a3d"],
    [0.5, 0.78, "#0f3d2a"],
  ],
  grain: 0.35,
  motion: "drift",
  speed: 0.6,
  loop: 0,
  hover: 0,
  hoverMode: "pull",
  effect: "none",
  effectSize: 8,
  effectAmount: 0.5,
};

function Backdrop({ id }: { id: BgId }) {
  // A fixed seed keeps the still frame identical between reloads, so two
  // candidates can be compared on the same pixel.
  if (id === "mesh") {
    return (
      <MeshGradient
        colors={PALETTE}
        distortion={0.7}
        swirl={0.4}
        grainMixer={0.25}
        grainOverlay={0.18}
        speed={0.25}
        scale={1.15}
      />
    );
  }
  if (id === "orb") {
    return (
      <NeuroNoise
        colorBack="#08090c"
        colorMid="#0f3d2a"
        colorFront="#2fbf71"
        brightness={0.55}
        contrast={0.6}
        speed={0.4}
        scale={1.1}
      />
    );
  }
  if (id === "hazeglow") {
    return <Hazeglow config={HAZE_CONFIG} />;
  }
  return (
    <GradientBackground
      count={22}
      size={{ min: 620, max: 1180, pulse: 0.3 }}
      speed={{ x: { min: 12, max: 42 }, y: { min: 12, max: 42 } }}
      colors={{
        background: "#08090c",
        particles: ["#2fbf71", "#0f3d2a", "#0d2a3d"],
      }}
      blending="screen"
      opacity={{ center: 0.55, edge: 0.1 }}
      skew={-8}
      shapes={["c", "s", "t"]}
      className="h-full w-full"
    />
  );
}

function Shell({ bg }: { bg: BgId }) {
  return (
    /* The window: a 6px frame with floating panels, as Liner does it. */
    <div className="bg-background/80 relative grid h-dvh w-full grid-cols-[60px_1fr] gap-1.5 p-1.5">
      <div className="absolute inset-0 -z-10 overflow-hidden">
        <Backdrop id={bg} />
        {/* Legibility floor: the artwork never touches text directly. */}
        <div className="bg-background/55 absolute inset-0" />
      </div>

      <nav
        aria-label="Рейл"
        className="bg-surface-glass flex flex-col items-center gap-1.5 rounded-[var(--radius-item)] p-2 backdrop-blur-[20px]"
      >
        <div className="bg-primary size-8 rounded-[var(--radius-control)]" />
        <div className="mt-3 flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className={`size-9 rounded-[var(--radius-control)] ${
                i === 0 ? "bg-fill-strong" : "bg-fill"
              }`}
            />
          ))}
        </div>
      </nav>

      <main className="flex min-h-0 flex-col gap-1.5">
        <div className="bg-surface-glass rounded-[var(--radius-item)] px-5 py-4 backdrop-blur-[20px]">
          <p className="text-muted-foreground text-xs">Провайдер</p>
          <h1 className="text-foreground text-xl font-semibold tracking-tight">
            Plus In Plus Demo
          </h1>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-2 gap-1.5">
          {[
            { name: "Survival", version: "2026.11.1", tone: "text-line-online" },
            { name: "SkyBlock", version: "2026.11.1", tone: "" },
          ].map((server) => (
            <article
              key={server.name}
              className="bg-surface-glass flex flex-col gap-3 rounded-[var(--radius-item)] p-3.5 backdrop-blur-[20px]"
            >
              <div className="bg-fill flex h-24 items-center justify-center rounded-[var(--radius-control)]">
                <span className="text-muted-foreground text-xs">
                  обложка сервера
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <h2 className="text-foreground text-sm font-medium">
                  {server.name}
                </h2>
                <p className="text-muted-foreground line-clamp-2 text-[13px] leading-relaxed">
                  Классическое выживание с бережным отношением к игровому
                  процессу.
                </p>
                <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <span>Minecraft 1.21.1</span>
                  <span aria-hidden="true">·</span>
                  <span>pack.json</span>
                </p>
              </div>
            </article>
          ))}
        </div>

        <div className="bg-surface-glass flex items-center gap-3 rounded-[var(--radius-item)] p-3 backdrop-blur-[20px]">
          <div className="bg-fill size-9 rounded-[var(--radius-control)]" />
          <div className="min-w-0 flex-1">
            <p className="text-foreground truncate text-[13px] font-medium">
              Survival
            </p>
            <p className="text-muted-foreground text-xs">
              Сборка не изменилась · готова к запуску
            </p>
          </div>
          <button
            type="button"
            className="bg-foreground text-background rounded-[var(--radius-control)] px-4 py-2 text-[13px] font-medium"
          >
            Играть
          </button>
        </div>
      </main>
    </div>
  );
}

function Lab() {
  const initial = new URLSearchParams(window.location.search).get("bg");
  const [bg, setBg] = useState<BgId>(
    BACKDROPS.some((item) => item.id === initial) ? (initial as BgId) : "mesh",
  );
  const frame = useRef<HTMLDivElement>(null);

  // The picker is deliberately outside the design system: it must not become
  // part of what is being judged.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "h" || event.key === "H") {
        const node = frame.current;
        if (node) node.dataset.hidden = node.dataset.hidden ? "" : "1";
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="min-h-dvh bg-[#0a0a0a] p-3 font-sans">
      <div
        ref={frame}
        className="mb-3 flex flex-wrap items-center gap-2 text-[13px] text-white/70 [&[data-hidden='1']]:hidden"
      >
        <span className="mr-2 text-white/40">Фон (H — скрыть панель):</span>
        {BACKDROPS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={item.id === bg}
            onClick={() => setBg(item.id)}
            title={item.note}
            className={`rounded-md border px-3 py-1.5 ${
              item.id === bg
                ? "border-white/40 bg-white/15 text-white"
                : "border-white/10 bg-white/5 hover:bg-white/10"
            }`}
          >
            {item.name}
          </button>
        ))}
        <span className="ml-auto text-white/35">
          {BACKDROPS.find((item) => item.id === bg)?.note}
        </span>
      </div>
      <div className="h-[calc(100dvh-84px)] overflow-hidden rounded-lg">
        <Shell bg={bg} />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <LazyMotion features={domAnimation} strict>
    <MotionConfig reducedMotion="user">
      <ThemeProvider>
        <Lab />
      </ThemeProvider>
    </MotionConfig>
  </LazyMotion>,
);
