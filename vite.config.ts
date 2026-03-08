import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

function normalizeBasePath(value: string | undefined): string {
  if (!value) {
    return "/";
  }
  if (value === "/") {
    return value;
  }
  return value[value.length - 1] === "/" ? value : `${value}/`;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  return {
    plugins: [react()],
    base: normalizeBasePath(env.BIG_TREE_VIEWER_BASE),
  };
});
