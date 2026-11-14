// Check the actual frontend entrypoints, not just the node_modules directory.
// CSS imports must resolve even in an incomplete/production-only npm install.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export function missingFrontendDependencies(root) {
  const require = createRequire(path.join(root, "package.json"));
  const modules = [
    "vite",
    "@vitejs/plugin-react",
    "@tailwindcss/vite",
    "tailwindcss/index.css",
    "shadcn/tailwind.css",
    "typescript",
  ];
  const missing = modules.filter((name) => {
    try {
      return !existsSync(require.resolve(name));
    } catch {
      return true;
    }
  });
  // This package exposes only a CSS `style` condition, not a Node entrypoint.
  if (
    !existsSync(
      path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css"),
    )
  )
    missing.push("tw-animate-css");
  return missing;
}

export const frontendDependenciesHelp =
  "Из корня проекта выполните: npm ci --include=dev. Если ошибка повторится, проверьте npm config get omit и NODE_ENV.";
