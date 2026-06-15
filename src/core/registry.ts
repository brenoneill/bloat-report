import type { ProviderAdapter } from "./adapter.js";

// Adapters register here at startup. Shared code only ever sees ProviderAdapter,
// so new providers (Codex next) plug in without touching detectors or commands.
const adapters = new Map<string, ProviderAdapter>();

export function registerAdapter(adapter: ProviderAdapter): void {
  adapters.set(adapter.id, adapter);
}

export function getAdapter(id: string): ProviderAdapter | undefined {
  return adapters.get(id);
}

/** All adapters, or just the one named — for honouring `--provider`. */
export function resolveAdapters(provider?: string): ProviderAdapter[] {
  if (provider) {
    const a = adapters.get(provider);
    return a ? [a] : [];
  }
  return [...adapters.values()];
}
