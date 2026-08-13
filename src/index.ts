export { loadConfig, type RegistryConfig, type RegistryConfigOverrides } from "./config.js";
export {
  CLI_VERSION,
  CliUsageError,
  loadEnvironmentFile,
  main,
  parseCliArgs,
  startRegistryServer,
  type CliOptions,
  type RegistryRuntime,
} from "./cli.js";
export { RegistryError } from "./errors.js";
export { createRegistryHttpServer } from "./http.js";
export { DEFAULT_INSTANCE_ID, RegistryService } from "./service.js";
export { EtcdRegistryStore } from "./store/etcd.js";
export { MemoryRegistryStore } from "./store/memory.js";
export type {
  AgentInstance,
  AgentPage,
  AgentQuery,
  RegisteredAgent,
  RegistrationInput,
  RegistryStore,
  StoredAgent,
} from "./types.js";
