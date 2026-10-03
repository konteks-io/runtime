export type KeyVerdict = "valid" | "rejected" | "unreachable";

/**
 * Check an API key against a provider's model list (no tokens spent): a 2xx
 * accepts it, a status in `rejected` refuses it, anything else (or no
 * answer) leaves it unchecked.
 */
export async function checkApiKey(url: string, headers: Record<string, string>, rejected: readonly number[], deps: { fetch?: typeof fetch; timeoutMs?: number }): Promise<KeyVerdict> {
  const fetchFn = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 15_000;
  try {
    const response = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) return "valid";
    return rejected.includes(response.status) ? "rejected" : "unreachable";
  } catch {
    return "unreachable";
  }
}
