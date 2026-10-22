import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/index.ts",
  // Wrangler applies plain .sql files from this directory in filename order.
  out: "./migrations",
});
