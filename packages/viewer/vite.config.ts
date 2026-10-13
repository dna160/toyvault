import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Dev: proxy the API (TOYVAULT_API, default the local API on :3000).
    proxy: Object.fromEntries(
      ["/v1", "/auth", "/healthz"].map((p) => [p, { target: process.env.TOYVAULT_API ?? "http://localhost:3000", changeOrigin: true }]),
    ),
  },
  build: { outDir: "dist", sourcemap: true },
});
