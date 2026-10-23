import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** Where `wrangler dev` serves the API worker locally. */
const API_ORIGIN = "http://127.0.0.1:8787";

// NOTE: changeOrigin stays off so the worker sees the browser's Host header. Better Auth
// compares Origin against the request host for CSRF protection; rewriting Host to
// 127.0.0.1:8787 would make every sign-in from the dev server look cross-site.
const proxyEntry = { target: API_ORIGIN, changeOrigin: false, ws: true } as const;

/** Where production source maps go instead of `dist` (gitignored). */
const SOURCEMAP_DIR = resolve(import.meta.dirname, "sourcemaps");

/**
 * Moves the build's `.map` files out of `dist` into {@link SOURCEMAP_DIR}.
 *
 * The Worker serves everything in `dist`, so shipped maps would publish the full source
 * of every release. With `sourcemap: "hidden"` the bundles carry no `sourceMappingURL`,
 * and keeping the maps beside the build (rather than deleting them) still lets a
 * maintainer decode a minified stack trace from that build.
 *
 * @returns The Vite plugin.
 */
function moveSourcemapsOutOfDist(): Plugin {
  return {
    name: "roundhouse:move-sourcemaps-out-of-dist",
    apply: "build",
    buildStart() {
      rmSync(SOURCEMAP_DIR, { recursive: true, force: true });
    },
    writeBundle(options, bundle) {
      const outDir = options.dir ?? resolve(import.meta.dirname, "dist");
      for (const fileName of Object.keys(bundle)) {
        if (!fileName.endsWith(".map")) continue;
        const target = join(SOURCEMAP_DIR, fileName);
        mkdirSync(dirname(target), { recursive: true });
        renameSync(join(outDir, fileName), target);
      }
    },
  };
}

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routeFileIgnorePattern: "\\.test\\.",
    }),
    react(),
    tailwindcss(),
    moveSourcemapsOutOfDist(),
  ],
  server: {
    port: 5173,
    proxy: {
      "/v1": proxyEntry,
      "/api": proxyEntry,
    },
  },
  preview: {
    port: 4173,
    proxy: {
      "/v1": proxyEntry,
      "/api": proxyEntry,
    },
  },
  build: {
    outDir: "dist",
    sourcemap: "hidden",
  },
});
