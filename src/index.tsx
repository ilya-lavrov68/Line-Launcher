import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./brand/generated.css";
import App from "./App";
import { bootstrapTheme } from "@/lib/line/theme";

// Before the first paint: choosing the stored design here avoids a visible
// palette swap on a cold start.
bootstrapTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
