import type { Store } from "@emulators/core";
import { DiscordEventBus } from "./gateway/dispatcher.js";

/**
 * Per-store runtime singletons (the event bus, the resolved base URL) shared between
 * `register()` (which wires the REST routes) and `attach()` (which starts the Gateway
 * WebSocket). Keyed by the `Store` instance in a WeakMap so it survives `store.reset()`
 * (which only clears collections/data) and is garbage-collected with the store.
 */
export interface DiscordRuntime {
  bus: DiscordEventBus;
  baseUrl: string;
}

const runtimes = new WeakMap<Store, DiscordRuntime>();

export function getDiscordRuntime(store: Store, baseUrl?: string): DiscordRuntime {
  let rt = runtimes.get(store);
  if (!rt) {
    rt = { bus: new DiscordEventBus(), baseUrl: baseUrl ?? "" };
    runtimes.set(store, rt);
  }
  if (baseUrl && !rt.baseUrl) rt.baseUrl = baseUrl;
  return rt;
}

export function clearDiscordRuntime(store: Store): void {
  const rt = runtimes.get(store);
  if (rt) rt.bus.clear();
  runtimes.delete(store);
}
