import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LazyMotion, domAnimation } from "framer-motion";
import ServerList from "../../../src/components/line/ServerList";
import type { LineServer } from "../../../src/types/line";
import type { ServerLayout } from "../../../src/lib/line/server-layout";
import "../../../src/index.css";

const servers: LineServer[] = [
  {
    id: "one",
    name: "One",
    description: "First",
    version: "1",
    distribution: { url: "" },
  },
  {
    id: "two",
    name: "Two",
    description: "Second",
    version: "1",
    distribution: { url: "" },
  },
];
const initial: ServerLayout = {
  sections: [
    { id: "a", name: "Alpha", collapsed: false },
    { id: "b", name: "Beta", collapsed: true },
  ],
  assignments: { one: "a", two: "a" },
};

function App() {
  const [layout, setLayout] = useState<ServerLayout>(() => {
    const saved = localStorage.getItem("drag-layout");
    return saved ? (JSON.parse(saved) as ServerLayout) : initial;
  });
  const [opened, setOpened] = useState("");
  return (
    <LazyMotion features={domAnimation}>
      <main style={{ width: 900, margin: 40 }}>
        <span data-opened>{opened}</span>
        <ServerList
          providerName="Provider"
          servers={servers}
          layout={layout}
          onLayoutChange={(next) => {
            setLayout(next);
            localStorage.setItem("drag-layout", JSON.stringify(next));
          }}
          onSelect={(server) => setOpened(server.id)}
          onRefresh={() => {}}
        />
      </main>
    </LazyMotion>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
