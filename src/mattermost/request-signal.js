// Associate cancellation with this agent's calls, never with a shared Client4 instance.
import { AsyncLocalStorage } from "node:async_hooks";
const context = new AsyncLocalStorage();
export const requestSignal = () => context.getStore();
export const withRequestSignal = (signal, run) => context.run(signal, run);

export function combineSignals(...values) {
  const signals = [...new Set(values.filter(Boolean))];
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
}
