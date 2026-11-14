import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LazyMotion, domAnimation, MotionConfig } from "framer-motion";
import ServerDetail from "../../../src/components/line/ServerDetail";
import SideNav from "../../../src/components/line/SideNav";
import ServerList from "../../../src/components/line/ServerList";
import { lineApi } from "../../../src/lib/line/api";
import type {
  LineServer,
  McInstallProgress,
  McGameStatus,
  InstallProgress,
} from "../../../src/types/line";
import "../../../src/index.css";

let progress: ((p: McInstallProgress) => void) | undefined;
let finish: ((s: McGameStatus) => void) | undefined;
let requests = 0;
let rejectPlay: ((reason: unknown) => void) | undefined;
let latestRequest: unknown;
Object.assign(lineApi, {
  mcStatus: async () => ({ instanceId: "one", versionId: "", phase: "idle" }),
  mcListInstalled: async () => [],
  onMcGame: async () => () => {},
  onMcProgress: async (_id: string, cb: (p: McInstallProgress) => void) => {
    progress = cb;
    return () => {};
  },
  mcPlay: (request: unknown) => {
    requests++;
    latestRequest = request;
    return new Promise<McGameStatus>((resolve, reject) => {
      finish = resolve;
      rejectPlay = reject;
    });
  },
});
Object.assign(window, {
  pushProgress: () =>
    progress?.({
      instanceId: "one",
      stage: "source-files",
      label: "",
      receivedBytes: 0,
      filesDone: 100,
      filesTotal: 500,
      finished: false,
    }),
  finishPlay: () =>
    finish?.({ instanceId: "one", versionId: "1", phase: "idle" }),
  requestCount: () => requests,
  lastRequest: () => latestRequest,
  failPlay: () =>
    rejectPlay?.({ code: "INTERNAL", message: "fixture failure" }),
});
const minecraft: LineServer = {
  id: "one",
  name: "BattleArmory",
  description: "Pack",
  version: "1",
  launch_mode: "minecraft",
  minecraft_version: "1.20.1",
  distribution: { url: "" },
  source: { kind: "modrinth", project: "x", version: "y" },
};
const archive: LineServer = {
  id: "two",
  name: "Other",
  description: "Pack",
  version: "1",
  distribution: { url: "" },
};
function App() {
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"minecraft" | "archive">("minecraft");
  const [installing, setInstalling] = useState(false);
  const install: InstallProgress | null = installing
    ? {
        operationId: "1",
        serverId: "two",
        phase: "downloading",
        percent: 30,
        receivedBytes: 1,
        totalBytes: 2,
        extractedBytes: 0,
        unpackedBytes: 0,
      }
    : null;
  return (
    <LazyMotion features={domAnimation}>
      <MotionConfig reducedMotion="always">
        <div className="flex min-h-screen gap-2 p-3">
          <SideNav
            section="servers"
            collapsed
            providerName="Provider"
            navigationDisabled={busy}
            actionsDisabled={busy}
            onNavigate={() => {}}
            onToggleCollapsed={() => {}}
            onChangeProvider={() => {}}
            onAbout={() => {}}
          />
          <main className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
            <div>
              <button
                data-test-mode-switch
                onClick={() =>
                  setMode(mode === "minecraft" ? "archive" : "minecraft")
                }
              >
                Switch fixture
              </button>
            </div>
            <ServerDetail
              server={mode === "minecraft" ? minecraft : archive}
              hasSession
              receipt={null}
              progress={install}
              status={null}
              installing={installing}
              launching={false}
              actionsBusy={busy}
              availability="ready"
              historyOpen={false}
              history={null}
              historyLoading={false}
              username="Player_1"
              onRefreshConfig={async () => {}}
              onMinecraftBusyChange={setBusy}
              onBack={() => {}}
              onInstall={() => setInstalling(true)}
              onCancel={() => setInstalling(false)}
              onLaunch={() => {}}
              onStop={() => {}}
              onHistory={() => {}}
              onRollback={() => {}}
              onCheckPacks={async () => ({ findings: [], foreign: [] })}
            />
          </main>
        </div>
      </MotionConfig>
    </LazyMotion>
  );
}
function Catalogue() {
  const [refreshing, setRefreshing] = useState(false);
  return (
    <LazyMotion features={domAnimation}>
      <MotionConfig reducedMotion="always">
        <main style={{ maxWidth: 900, margin: 40 }}>
          <ServerList
            providerName="Provider"
            servers={[minecraft]}
            layout={{ sections: [], assignments: {} }}
            refreshing={refreshing}
            onRefresh={() => setRefreshing(true)}
            onSelect={() => {}}
            onLayoutChange={() => {}}
          />
        </main>
      </MotionConfig>
    </LazyMotion>
  );
}
createRoot(document.getElementById("root")!).render(
  location.search ? <Catalogue /> : <App />,
);
