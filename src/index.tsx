import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./brand/generated.css";
import App from "./App";
import { lineApi } from "./lib/line/api";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The desktop window is created hidden so that the first thing a player sees is
// the launcher and not the WebView's white rectangle. Reveal it after the first
// committed frame: `requestAnimationFrame` fires before paint, so it takes two
// of them to be past the frame that contains the backdrop. The call is a no-op
// outside Tauri and the Rust side shows the window on a timer if this never
// runs.
const revealWindow = () => {
  void lineApi.showMainWindow();
};
requestAnimationFrame(() => {
  requestAnimationFrame(revealWindow);
});
