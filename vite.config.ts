import { defineConfig, loadEnv } from "vite";

/**
 * Plain Vite. The backend is Convex; Cloudflare serves the built static assets.
 *
 * In dev, Convex's traffic (`/api/…`, including the sync websocket) is proxied
 * through Vite to the local backend, and the client dials the page's own
 * origin. So a jam opened from another machine (http://<this machine>:5173)
 * works: pointed at 127.0.0.1:3210 directly, that browser would dial itself.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    server: {
      proxy: {
        "/api": { target: env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210", ws: true, changeOrigin: true },
      },
    },
  };
});
