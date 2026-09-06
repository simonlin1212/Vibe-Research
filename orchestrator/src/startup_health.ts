/** Check the UI and its authenticated API proxy without exposing the bearer token. */
import { fileURLToPath } from "node:url";

export async function productUiReady(baseUrl = "http://127.0.0.1:5930", timeoutMs = 1_000): Promise<boolean> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const [ui, api] = await Promise.all([
      fetch(`${baseUrl}/`, { signal }), fetch(`${baseUrl}/api/health`, { signal }),
    ]);
    if (!ui.ok || !api.ok || !ui.headers.get("content-type")?.includes("text/html")) return false;
    const [html, health] = await Promise.all([ui.text(), api.json()]);
    return /<div\b[^>]*\bid=["']root["']/.test(html) && health?.ok === true &&
      typeof health.version === "string" && health.version.length > 0;
  } catch {
    return false;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await productUiReady() ? 0 : 2;
}
