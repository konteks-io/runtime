import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";

/**
 * The standard proxy variables for an outgoing HTTPS connection the connector
 * makes itself (Google Antigravity's download and its Gemini API key relay):
 * `HTTPS_PROXY` (or `ALL_PROXY`, either case) unless `NO_PROXY` covers the
 * host, reached through an HTTP CONNECT tunnel so the TLS session to the
 * target runs end to end inside it. Plain `http:` targets never use a proxy.
 */

class HttpsProxyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HttpsProxyError";
  }
}

/** The proxy for an https URL from the standard variables, unless `NO_PROXY` covers its host; null for none. */
export function httpsProxyFor(url: URL, env: NodeJS.ProcessEnv = process.env): URL | null {
  if (url.protocol !== "https:") return null;
  const value = env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy;
  if (!value) return null;
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? "").split(/[\s,]+/).map(entry => entry.trim().toLowerCase()).filter(Boolean);
  const host = url.hostname.toLowerCase();
  for (const entry of noProxy) {
    if (entry === "*") return null;
    const bare = entry.replace(/:\d+$/, "").replace(/^\*?\./, "");
    if (host === bare || host.endsWith(`.${bare}`)) return null;
  }
  let proxy: URL;
  try { proxy = new URL(value.includes("://") ? value : `http://${value}`); } catch { throw new HttpsProxyError("the proxy setting is not a URL"); }
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") throw new HttpsProxyError("only http and https proxies are supported");
  return proxy;
}

/** An HTTP CONNECT tunnel to `target` through `proxy`; the caller runs its TLS session to the target inside it. */
export async function openHttpsProxyTunnel(proxy: URL, target: URL, idleMs: number): Promise<Socket> {
  const authority = `${target.hostname}:${target.port || 443}`;
  const headers: Record<string, string> = { host: authority };
  if (proxy.username) headers["proxy-authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
  const requestFn = proxy.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = requestFn({ host: proxy.hostname, port: proxy.port || (proxy.protocol === "https:" ? 443 : 80), method: "CONNECT", path: authority, headers, agent: false });
    req.setTimeout(idleMs, () => req.destroy(new Error("the proxy did not answer")));
    req.on("connect", (response: IncomingMessage, socket: Socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new HttpsProxyError(`the proxy refused the connection (${response.statusCode})`));
        return;
      }
      resolve(socket);
    });
    req.on("error", error => reject(new HttpsProxyError("the proxy could not be reached", { cause: error })));
    req.end();
  });
}
