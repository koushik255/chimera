import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: [
      "koushik.tail90d2bb.ts.net",
      ".trycloudflare.com",
      "koushikkoushik.com",
      ".koushikkoushik.com",
    ],
    port: 5173,
    proxy: {
      "/api": "http://localhost:8000",
      "/pages": "http://localhost:8000",
      "/debug": "http://localhost:8000",
    },
  },
  build: {
    target: "esnext",
  },
});
