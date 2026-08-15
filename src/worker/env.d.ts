// Secrets are not part of wrangler.jsonc, so `wrangler types` can't see them.
// Declared here so the generated Env stays authoritative for bindings while
// secrets are still typed. Set with:
//   npx wrangler secret put ANTHROPIC_API_KEY
//   npx wrangler secret put APP_SECRET
interface Env {
  ANTHROPIC_API_KEY?: string;
  APP_SECRET?: string;
}
