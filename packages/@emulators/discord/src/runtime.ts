import type { Store } from "@emulators/core";
import { DiscordEventBus } from "./gateway/dispatcher.js";

/**
 * Per-store event bus shared between `register()` (which wires the REST routes) and `attach()`
 * (which starts the Gateway WebSocket). Keyed by the `Store` in a WeakMap so it survives
 * `store.reset()` (which only clears collections/data) and is garbage-collected with the store.
 */
export interface DiscordRuntime {
  bus: DiscordEventBus;
}

const runtimes = new WeakMap<Store, DiscordRuntime>();

export function getDiscordRuntime(store: Store): DiscordRuntime {
  let rt = runtimes.get(store);
  if (!rt) {
    rt = { bus: new DiscordEventBus() };
    runtimes.set(store, rt);
  }
  return rt;
}

export function clearDiscordRuntime(store: Store): void {
  const rt = runtimes.get(store);
  if (rt) rt.bus.clear();
  runtimes.delete(store);
}
