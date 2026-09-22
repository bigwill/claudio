import { defineConfig } from "vite";

/**
 * Plain Vite. The @cloudflare/vite-plugin is gone with the Worker it existed to
 * bundle — Cloudflare now serves static assets and nothing else, and the backend
 * is Convex.
 *
 * A welcome side effect: the CLOUDFLARE_ENV build-time trap goes with it. The
 * plugin baked a fully-resolved Worker config into dist/, which meant
 * `wrangler deploy --env production` was silently ignored and the environment had
 * to be chosen at BUILD time. With no Worker script, --env behaves normally
 * again — see the deploy scripts in package.json.
 */
export default defineConfig({});
