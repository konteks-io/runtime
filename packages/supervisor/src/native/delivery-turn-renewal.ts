/**
 * Advertised with delivery permits: this connector adopts a delivery turn's
 * renewed lifetime from Core's signed answers (NativeExecutionGate), so
 * Core may renew its turns past their issued hour. Core never renews a
 * connector that does not advertise it.
 */
export const DELIVERY_TURN_RENEWAL_CAPABILITY = "delivery-turn-renewal-v1";
