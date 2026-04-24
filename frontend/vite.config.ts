import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  server: {
    allowedHosts: ["koushik.tail90d2bb.ts.net"],
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
