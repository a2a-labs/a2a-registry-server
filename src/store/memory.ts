import type { Clock, RegistryStore, StoredAgent } from "../types.js";

const systemClock: Clock = { now: () => Date.now() };

export class MemoryRegistryStore implements RegistryStore {
  readonly name = "memory";
  readonly #agents = new Map<string, StoredAgent>();
  readonly #clock: Clock;
  readonly #pruneIntervalMs: number;
  #timer?: NodeJS.Timeout;

  constructor(pruneIntervalMs = 5000, clock: Clock = systemClock) {
    this.#pruneIntervalMs = pruneIntervalMs;
    this.#clock = clock;
  }

  async start(): Promise<void> {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.prune(), this.#pruneIntervalMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async ready(): Promise<boolean> {
    return true;
  }

  async get(id: string): Promise<StoredAgent | undefined> {
    const agent = this.#agents.get(id);
    if (agent && this.isExpired(agent)) {
      this.#agents.delete(id);
      return undefined;
    }
    return agent === undefined ? undefined : structuredClone(agent);
  }

  async list(): Promise<StoredAgent[]> {
    this.prune();
    return [...this.#agents.values()].map((agent) => structuredClone(agent));
  }

  async put(agent: StoredAgent): Promise<void> {
    this.#agents.set(agent.id, structuredClone(agent));
  }

  async renew(agent: StoredAgent): Promise<void> {
    this.#agents.set(agent.id, structuredClone(agent));
  }

  async delete(agent: StoredAgent): Promise<boolean> {
    return this.#agents.delete(agent.id);
  }

  private isExpired(agent: StoredAgent): boolean {
    return Date.parse(agent.expiresAt) <= this.#clock.now();
  }

  private prune(): void {
    for (const [id, agent] of this.#agents) {
      if (this.isExpired(agent)) this.#agents.delete(id);
    }
  }
}
