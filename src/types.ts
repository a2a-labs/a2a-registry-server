import type { AgentCard } from "@a2a-js/sdk";

export type JsonObject = Record<string, unknown>;

/** One independently leased runtime instance of a logical agent. */
export interface AgentInstance {
  instanceId: string;
  endpoint: string;
  ttlSeconds: number;
  registeredAt: string;
  updatedAt: string;
  lastSeen: string;
  expiresAt: string;
  metadata: Record<string, string>;
  revision: number;
}

/** Public logical agent returned to discovery clients. */
export interface RegisteredAgent {
  id: string;
  name: string;
  agentCard: AgentCard;
  instances: AgentInstance[];
  instanceCount: number;

  /**
   * Compatibility projection of the default (or first) active instance.
   * New clients should use `instances`.
   */
  endpoint: string;
  ttlSeconds: number;
  registeredAt: string;
  updatedAt: string;
  lastSeen: string;
  expiresAt: string;
  metadata: Record<string, string>;
  revision: number;
}

/** Internal instance record. Internal fields are never serialized by HTTP. */
export interface StoredAgent extends AgentInstance {
  id: string;
  name: string;
  agentCard: AgentCard;
  leaseTokenHash: string;
  backendLeaseId?: string;
  backendRevision?: string;
}

export interface RegistrationInput {
  id: string;
  instanceId?: string;
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
  get(id: string, instanceId: string): Promise<StoredAgent | undefined>;
  list(): Promise<StoredAgent[]>;
  put(agent: StoredAgent): Promise<void>;
  renew(agent: StoredAgent): Promise<void>;
  delete(agent: StoredAgent): Promise<boolean>;
}

export interface Clock {
  now(): number;
}
