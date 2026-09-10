import { defineConfig } from "vite";

// Dev-Server proxyt API/WS ans Backend. Default: lokales uvicorn auf :8080.
// Für einen reinen Frontend-Test gegen eine laufende Instanz:
//   $env:VITE_API_TARGET="http://192.168.1.115:8080"; node .\node_modules\vite\bin\vite.js
// changeOrigin + gesetzter Origin-Header, damit die serverseitige WS-Origin-Prüfung
// (security.origin_allowed) den proxied Handshake nicht ablehnt.
const API = process.env.VITE_API_TARGET || "http://localhost:8080";
const proxyEntry = (ws = false) => ({ target: API, changeOrigin: true, ws, headers: { origin: API } });

export default defineConfig({
  server: {
    proxy: {
      "/healthz": proxyEntry(),
      "/auth": proxyEntry(true), // /auth/*/live gibt es nicht, aber schadet nicht
      "/api": proxyEntry(),
      "/plans": proxyEntry(true),
      "/public": proxyEntry(true),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2200,
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ["maplibre-gl"],
          milsymbol: ["milsymbol"],
        },
      },
    },
  },
});
