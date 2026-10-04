/**
 * Pieces of the connector's direct HTTPS exchanges with Core for assignment
 * inputs and generated output: a plain https origin, the response's media
 * type, and a wait that ends when the request's deadline aborts it.
 */

/** The origin of a plain https base URL (no credentials, query, fragment or path); null for any other. */
export function coreOrigin(baseUrl: string): string | null {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  return url.pathname === "/" || url.pathname === "" ? url.origin : null;
}

/** The response's media type, lowercased, without its parameters. */
export function mediaType(response: Response): string | undefined {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

/** Statuses Core answers when the runtime lease changed while the request was in flight. */
export const LEASE_REFUSAL_STATUSES: readonly number[] = [401, 403, 422];

/** `promise`, rejected with `aborted()` as soon as `signal` aborts. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal, aborted: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(aborted());
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
