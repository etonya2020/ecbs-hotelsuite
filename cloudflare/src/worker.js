import { Container, getContainer } from "@cloudflare/containers";

// One container running the ECBS Node server. All data lives in the external PostgreSQL (DATABASE_URL),
// never in the container, so the container can be restarted or put to sleep at any time.
export class EcbsApp extends Container {
  defaultPort = 3000;
  sleepAfter = "2h"; // stays warm while people use it; sleeps when idle (the nightly cron below wakes it for room billing)
  constructor(ctx, env) {
    super(ctx, env);
    const pick = ["DATABASE_URL", "DATA_KEY", "ADMIN_USER", "ADMIN_PASSWORD", "DEV_USER", "DEV_PASSWORD", "TZ", "SESSION_IDLE_MIN",
      "PLATFORM_OWNER_USER", "PLATFORM_OWNER_PASSWORD", "PLATFORM_OWNER_RESET", "ADMIN_RESET", "PLATFORM_HOST", "PLATFORM_DOMAIN"];
    this.envVars = {
      NODE_ENV: "production",
      DB_SSL: "true",
      TRUST_PROXY: "true",
      COOKIE_SECURE: "true",
      ...Object.fromEntries(pick.filter(k => env[k]).map(k => [k, String(env[k])])),
    };
  }
}

const box = env => getContainer(env.ECBS, "main"); // single instance: every client must reach the same server process

export default {
  async fetch(request, env) {
    // The app decides which client you are from the web address, so pass the ORIGINAL address and visitor IP
    // explicitly (and overwrite anything the visitor tried to send).
    const h = new Headers(request.headers);
    h.set("x-forwarded-host", new URL(request.url).host);
    h.set("x-forwarded-proto", "https");
    const ip = request.headers.get("cf-connecting-ip");
    if (ip) h.set("x-forwarded-for", ip); else h.delete("x-forwarded-for");
    return box(env).fetch(new Request(request, { headers: h }));
  },
  // Cron trigger (see wrangler.jsonc): wakes the server every morning so the 05:30 room-billing job runs on time
  async scheduled(event, env, ctx) {
    ctx.waitUntil(box(env).fetch(new Request("https://wake.internal/healthz")));
  },
};
