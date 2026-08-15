// Entry point. Real UI + drain loop land next; this keeps the bundle valid
// so we can deploy early and set secrets against a live Worker.

const boot = document.getElementById("boot");
const key = new URLSearchParams(location.search).get("k");

async function ping() {
  const res = await fetch(`/api/ping${key ? `?k=${encodeURIComponent(key)}` : ""}`);
  const body = await res.json();
  if (boot) boot.textContent = `${res.status} — ${JSON.stringify(body)}`;
}

ping().catch((e) => {
  if (boot) boot.textContent = `ping failed: ${String(e)}`;
});
