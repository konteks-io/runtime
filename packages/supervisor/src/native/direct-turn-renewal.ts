/**
 * Advertised with execution permits: this connector adopts a direct or
 * Assistant turn's renewed lifetime from Core's signed answers
 * (NativeExecutionGate), so Core may renew its turns past their issued hour
 * (10-09: a direct turn was fenced one hour after the session's first
 * prompt). Core never renews a connector that does not advertise it.
 */
export const DIRECT_TURN_RENEWAL_CAPABILITY = "direct-turn-renewal-v1";
