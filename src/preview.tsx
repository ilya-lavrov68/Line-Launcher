import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { LazyMotion, MotionConfig, domAnimation } from "framer-motion";
import "./index.css";
import "./brand/generated.css";
import ThemeProvider from "@/components/line/ThemeProvider";
import { useTheme } from "@/components/line/ThemeProvider";
import ServerDetail from "@/components/line/ServerDetail";
import type {
  GameStatus,
  InstallProgress,
  InstallReceipt,
  LineServer,
} from "@/types/line";

/**
 * Development-only preview of the server dock (`/preview.html`).
 *
 * It exists so the two designs can be compared in a browser without a provider
 * server, an account or a real install: the states below are mocked on purpose
 * and this entry is never referenced by the app.
 */
const server: LineServer = {
  id: "survival",
  name: "Survival",
  description:
    "Основной мир проекта: выживание, торговля и общие постройки. Сборка обновляется вместе с сервером.",
  version: "1.4.2",
  minecraft_version: "1.21.1",
  launch_mode: "offline",
  server_address: "play.example.com:25565",
  distribution: {
    url: "https://cdn.example.com/pack.zip",
    sha256: "a".repeat(64),
    size_bytes: 734003200,
    unpacked_size_bytes: 1610612736,
  },
};

const receipt: InstallReceipt = {
  serverId: server.id,
  version: "1.4.2",
  sha256: server.distribution.sha256,
  installedAt: 0,
  alreadyInstalled: false,
};

const progress = (
  phase: InstallProgress["phase"],
  percent: number,
): InstallProgress => ({
  operationId: "00000000-0000-4000-8000-000000000000",
  serverId: server.id,
  phase,
  percent,
  receivedBytes: Math.round((server.distribution.size_bytes * percent) / 100),
  totalBytes: server.distribution.size_bytes,
  extractedBytes: 0,
  unpackedBytes: server.distribution.unpacked_size_bytes,
});

const scenarios: {
  id: string;
  label: string;
  receipt: InstallReceipt | null;
  progress: InstallProgress | null;
  status: GameStatus | null;
  error?: string;
}[] = [
  {
    id: "installed",
    label: "Готов к запуску",
    receipt,
    progress: null,
    status: null,
  },
  {
    id: "install",
    label: "Сборка не скачана",
    receipt: null,
    progress: null,
    status: null,
  },
  {
    id: "downloading",
    label: "Загрузка 45%",
    receipt: null,
    progress: progress("downloading", 45),
    status: null,
  },
  {
    id: "update",
    label: "Доступно обновление",
    receipt: { ...receipt, sha256: "b".repeat(64) },
    progress: null,
    status: null,
  },
  {
    id: "running",
    label: "Игра запущена",
    receipt,
    progress: null,
    status: {
      serverId: server.id,
      revision: 2,
      phase: "running",
      startedAt: Date.now(),
    },
  },
  {
    id: "error",
    label: "Ошибка",
    receipt,
    progress: null,
    status: null,
    error:
      "Не удалось скачать архив: сервер провайдера не отвечает. Проверьте соединение и повторите.",
  },
];

function Preview() {
  const { theme, setTheme } = useTheme();
  const [scenario, setScenario] = useState(scenarios[0].id);

  // `?theme=old` lets both designs be compared by URL, which also makes the
  // old theme openable from a link instead of only from the in-app toggle.
  const requested = new URLSearchParams(window.location.search).get("theme");
  useEffect(() => {
    if (requested === "old" || requested === "line") setTheme(requested);
    // Runs once: afterwards the toggle owns the value.
  }, [requested, setTheme]);
  const active = scenarios.find((item) => item.id === scenario) ?? scenarios[0];

  return (
    <div className="flex min-h-screen flex-col gap-4 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-muted-foreground font-mono text-[10px]">
            Line Launcher · предпросмотр дизайна · тема «{theme}»
          </p>
          <a
            href={theme === "line" ? "?theme=old" : "?theme=line"}
            className="text-primary text-[11px] underline-offset-2 hover:underline"
          >
            {theme === "line"
              ? "Показать старый дизайн"
              : "Показать новый дизайн"}
          </a>
          <h1 className="text-foreground text-lg font-semibold">
            Панель действия сервера
          </h1>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {scenarios.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setScenario(item.id)}
              aria-pressed={item.id === scenario}
              className={`rounded-[var(--radius-control)] border px-2.5 py-1 text-[11px] ${
                item.id === scenario
                  ? "border-primary/40 bg-primary/15 text-foreground"
                  : "border-border text-muted-foreground hover:bg-fill"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      <div className="mx-auto w-full max-w-xl">
        <ServerDetail
          server={server}
          providerName="Plus In Plus"
          hasSession
          receipt={active.receipt}
          progress={active.progress}
          status={active.status}
          installing={active.progress?.phase === "downloading"}
          launching={false}
          actionsBusy={false}
          installError={active.error}
          availability="ready"
          historyOpen={false}
          history={null}
          historyLoading={false}
          onBack={() => undefined}
          onInstall={() => undefined}
          onCancel={() => undefined}
          onLaunch={() => undefined}
          onStop={() => undefined}
          onHistory={() => undefined}
          onRollback={() => undefined}
        />
      </div>
    </div>
  );
}

// Same motion wiring as the app: `m` components require a LazyMotion tree.
createRoot(document.getElementById("root")!).render(
  <LazyMotion features={domAnimation} strict>
    <MotionConfig reducedMotion="user">
      <ThemeProvider>
        <Preview />
      </ThemeProvider>
    </MotionConfig>
  </LazyMotion>,
);
