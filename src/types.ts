import type { AgentCard } from "@a2a-js/sdk";

export type JsonObject = Record<string, unknown>;

/** Public registration returned to discovery clients. */
export interface RegisteredAgent {
  id: string;
  name: string;
  endpoint: string;
  agentCard: AgentCard;
  ttlSeconds: number;
  registeredAt: string;
  updatedAt: string;
  lastSeen: string;
  expiresAt: string;
  metadata: Record<string, string>;
  revision: number;
}

/** Internal fields are deliberately never serialized by the HTTP layer. */
export interface StoredAgent extends RegisteredAgent {
  leaseTokenHash: string;
  backendLeaseId?: string;
  backendRevision?: string;
}

export interface RegistrationInput {
  id: string;
  endpoint?: string;
  agentCard: AgentCard;
  ttlSeconds?: number;
  metadata?: Record<string, string>;
}

export interface AgentQuery {
  skill?: string;
  tag?: string;
  capability?: string;
  protocolBinding?: string;
  name?: string;
  limit: number;
  cursor?: string;
}

export interface AgentPage {
  agents: RegisteredAgent[];
  total: number;
  nextCursor?: string;
  revision: number;
}

export type RegistryEventType = "registered" | "updated" | "heartbeat" | "unregistered" | "expired";

export interface RegistryEvent {
  type: RegistryEventType;
  id: string;
  revision: number;
  timestamp: string;
}

export interface RegistryStore {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  ready(): Promise<boolean>;
  get(id: string): Promise<StoredAgent | undefined>;
  list(): Promise<StoredAgent[]>;
  put(agent: StoredAgent): Promise<void>;
  renew(agent: StoredAgent): Promise<void>;
  delete(agent: StoredAgent): Promise<boolean>;
}

export interface Clock {
  now(): number;
}
