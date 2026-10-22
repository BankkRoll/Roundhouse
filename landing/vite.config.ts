import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// NOTE: GitHub Pages serves a project site under /<repo>/, so the Pages workflow sets
// LANDING_BASE to "/Open-Rail/". Local dev and a custom domain serve from the root.
export default defineConfig({
  base: process.env.LANDING_BASE ?? "/",
  plugins: [react(), tailwindcss()],
  server: { port: 5174 },
  preview: { port: 4174 },
  build: { outDir: "dist" },
});
