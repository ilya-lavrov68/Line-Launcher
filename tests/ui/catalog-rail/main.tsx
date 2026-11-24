import { createRoot } from "react-dom/client";
import { ServerCatalogRail } from "../../../src/components/line/ServerCatalogRail";
import type { LineServer } from "../../../src/types/line";
import "../../../src/index.css";

const server: LineServer = {
  id: "no-art",
  name: "Example server without artwork",
  description: "Fallback artwork fixture for the catalog hero.",
  version: "1.0.0",
  distribution: { url: "https://example.invalid/build.zip" },
};

createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen w-full p-4">
    <div className="mx-auto w-full max-w-[1200px]">
      <ServerCatalogRail
        server={server}
        status="Сборка установлена"
        onOpen={() => {}}
      />
    </div>
  </main>,
);
