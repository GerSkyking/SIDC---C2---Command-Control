import { defineConfig } from "vite";

// Dev-Server proxyt API/WS ans lokale Backend (uvicorn auf :8080).
export default defineConfig({
  server: {
    proxy: {
      "/healthz": "http://localhost:8080",
      "/auth": "http://localhost:8080",
      "/api": "http://localhost:8080",
      "/plans": { target: "http://localhost:8080", ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
