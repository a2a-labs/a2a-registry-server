# A2A Registry Server

A lease-based registration and discovery service for AI agents that publish [A2A Agent Cards](https://a2a-protocol.org/latest/specification/). It turns the original single-file PoC into a small server with ownership tokens, TTL heartbeats, filtering, pagination, caching, metrics, tests, and an optional distributed etcd store.

This project is a registry **for** A2A agents. Its registry REST API is intentionally separate from the A2A task/message protocol. The A2A specification standardizes Agent Cards and describes registries/catalogs as a discovery mechanism, but it does not prescribe one universal registry API.

## Features

- Stores current A2A 1.0 Agent Cards without stripping unknown fields
- Accepts both v1 `supportedInterfaces[].url` and the legacy card `url`
- Lease/heartbeat model inspired by etcd and Consul TTL checks
- Per-registration lease token prevents another client from replacing or deleting an ID
- Optional global write bearer token controls who may create registrations
- Discovery by skill, skill tag, capability, protocol binding, or agent name
- Cursor pagination, ETags, readiness/liveness probes, Prometheus text metrics
- In-memory backend for development and an etcd v3 backend for replicated deployments
- Compatibility aliases for the routes and `ttlMs` field in the original PoC
- No web framework and only one runtime dependency: the official A2A TypeScript SDK

## Quick start

Requirements: Node.js 22 or newer.

```bash
npm install
cp .env.example .env
npm run dev
```

The process reads environment variables directly. If you use a `.env` file, load it with your process manager or shell. The default address is `http://localhost:3003`.

The same server is available as a standalone CLI after building the package. It accepts explicit configuration flags, which take precedence over environment variables, and can load a dotenv-compatible file itself:

```bash
npm run build
node dist/cli.js --env-file .env --host 127.0.0.1 --port 3003 --store memory
```

When installed as a package, the `a2a-registry` binary is available:

```bash
npx a2a-registry --help
a2a-registry --version
```

Use `--help` for all options. `SIGINT` and `SIGTERM` trigger a graceful shutdown that stops accepting connections, waits for active requests, and closes the storage backend.

## Agent Registry UI

The React/Vite dashboard now lives in the sibling `a2a-registry-ui` package. It lists agents from `/v1/agents`, supports text search and status/skill/tag/capability/protocol filters, opens a full Agent Card detail panel, and can block (unregister) an agent through a confirmation dialog.

Run it alongside this server from the workspace root:

```bash
cd ../a2a-registry-ui
npm install
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/v1` and `/health` to the registry at `http://localhost:3003`. Set `VITE_REGISTRY_API_URL` when the API is hosted elsewhere. When the API cannot be reached, the UI switches to clearly labeled sample data so the layout remains inspectable; destructive actions are local-only in that mode. Blocking a real agent requires `REGISTRY_WRITE_TOKEN` and the token can be entered in the confirmation dialog.

Register an agent:

```bash
curl -i http://localhost:3003/v1/agents \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "weather-eu-1",
    "ttlSeconds": 60,
    "metadata": { "region": "eu-west" },
    "agentCard": {
      "name": "Weather Agent",
      "description": "Returns local forecasts",
      "version": "1.0.0",
      "supportedInterfaces": [{
        "url": "https://weather.example/a2a",
        "protocolBinding": "HTTP+JSON",
        "protocolVersion": "1.0"
      }],
      "capabilities": { "streaming": true },
      "defaultInputModes": ["text/plain"],
      "defaultOutputModes": ["application/json"],
      "skills": [{
        "id": "forecast",
        "name": "Weather forecast",
        "description": "Forecast by location",
        "tags": ["weather"]
      }]
    }
  }'
```

The create response contains `leaseToken`. Save it securely: it is returned once and is required to update, renew, or remove the registration.

```bash
export AGENT_LEASE_TOKEN='<value from registration response>'

curl -X POST http://localhost:3003/v1/agents/weather-eu-1/heartbeat \
  -H "X-Registry-Lease-Token: $AGENT_LEASE_TOKEN"

curl 'http://localhost:3003/v1/agents?skill=forecast&capability=streaming&tag=weather'

curl -X DELETE http://localhost:3003/v1/agents/weather-eu-1 \
  -H "X-Registry-Lease-Token: $AGENT_LEASE_TOKEN"
```

Send a heartbeat well before `ttlSeconds` elapses—normally every one-third of the TTL, with jitter and retry backoff.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/agents` | Create a registration |
| `PUT` | `/v1/agents/{id}` | Create or replace a registration |
| `POST` | `/v1/agents/{id}/heartbeat` | Renew its lease |
| `GET` | `/v1/agents` | Discover active agents |
| `GET` | `/v1/agents/{id}` | Fetch one registration and Agent Card |
| `DELETE` | `/v1/agents/{id}` | Unregister it |
| `GET` | `/health/live` | Process liveness |
| `GET` | `/health/ready` | Storage readiness |
| `GET` | `/metrics` | Prometheus text metrics |
| `GET` | `/openapi.yaml` | OpenAPI 3.1 document |

Discovery accepts `skill`, `tag`, `capability`, `protocolBinding`, `name`, `limit`, and `cursor`. The list only includes unexpired registrations.

PoC-compatible aliases remain available at `/v1/registry`, `/v1/registry/register`, `/v1/registry/agents`, and `/v1/registry/heartbeat`. They use the new ownership rules.

## Configuration

| Variable | Default | Meaning |
|---|---:|---|
| `REGISTRY_HOST` | `0.0.0.0` | Listen address |
| `REGISTRY_PORT` | `3003` | Listen port |
| `REGISTRY_PUBLIC_URL` | local port URL | Base URL used in service metadata |
| `REGISTRY_STORE` | `memory` | `memory` or `etcd` |
| `REGISTRY_DEFAULT_TTL_SECONDS` | `60` | Lease TTL if omitted |
| `REGISTRY_MIN_TTL_SECONDS` | `10` | Lowest accepted TTL |
| `REGISTRY_MAX_TTL_SECONDS` | `3600` | Highest accepted TTL |
| `REGISTRY_WRITE_TOKEN` | unset | If set, registrations require `Authorization: Bearer …` |
| `REGISTRY_CORS_ORIGIN` | `*` | CORS allow-origin value |
| `REGISTRY_MAX_BODY_BYTES` | `1048576` | Maximum JSON body size |
| `ETCD_ENDPOINT` | `http://localhost:2379` | etcd v3 JSON gateway |
| `ETCD_PREFIX` | `/a2a-registry/agents/` | etcd key prefix |
| `ETCD_USERNAME`, `ETCD_PASSWORD` | unset | etcd authentication credentials |
| `ETCD_BEARER_TOKEN` | unset | Pre-issued etcd auth token |

## Distributed deployment with etcd

```bash
docker compose up --build
```

The etcd adapter grants a lease for each registration and attaches the registry key to it. A heartbeat atomically reattaches the key to a new lease and revokes the previous lease. When the agent stops renewing, etcd removes the key even if the registry process that accepted it has failed. All registry replicas must use the same `ETCD_PREFIX` and cluster.

For production, enable etcd authentication and TLS, use a dedicated least-privilege role restricted to the registry prefix, and run an odd-sized etcd cluster. The current adapter accepts an HTTPS endpoint but does not yet expose custom CA/client-certificate file settings.

## Security model

- `REGISTRY_WRITE_TOKEN` is an enrollment control; enable it outside trusted development networks.
- `X-Registry-Lease-Token` proves ownership of one registration. Only its SHA-256 hash is stored.
- Put TLS and an identity-aware proxy/API gateway in front of the server. A shared write token is not a replacement for OAuth2, workload identity, or mTLS.
- The server validates structure and URLs but does not fetch an endpoint during registration, avoiding a registration-time SSRF path.
- Agent Cards are public discovery metadata. Do not place credentials or internal secrets in them.
- Signed Agent Cards are preserved but signature verification and trust policy are deployment-specific and are not performed yet.

## What to add next

1. **Identity and policy:** OIDC/mTLS identities, tenant namespaces, RBAC, admission policy, and audit events. Bind the authenticated identity to the registered agent ID.
2. **Trust:** verify A2A Agent Card JWS signatures, restrict `jku` origins, maintain trusted issuers/keys, and record verification status without modifying the signed card.
3. **Active health checks:** optional HTTP/TCP/gRPC probes and passing/warning/critical states, similar to Consul. Keep active checks separate from agent-driven TTL heartbeats.
4. **Watch API:** Server-Sent Events or gRPC streaming over storage revisions so clients can update a local resolver without polling. etcd watches or Consul blocking queries are natural backends.
5. **Multiple instances and locality:** model a logical agent/service separately from instances, then support zone/region/weight/health-aware selection and client-side round-robin.
6. **Consul adapter:** use Consul sessions/TTL checks and KV/catalog metadata when an organization already operates Consul.
7. **Operations:** OpenTelemetry traces, labeled/rate metrics with bounded cardinality, rate limiting, quotas, backups, chaos tests, and SLO dashboards.
8. **Governance:** moderation/approval workflows, metadata schemas, retention, version compatibility policy, and a documented response to compromised registrations.

## Development

```bash
npm run check
npm test
npm run build
```

The memory store is used in unit/integration tests. Add an etcd container test before changing lease behavior.

## References

- [A2A 1.0 specification](https://a2a-protocol.org/latest/specification/)
- [A2A discovery guide](https://github.com/a2aproject/A2A/blob/main/docs/topics/agent-discovery.md)
- [Official TypeScript SDK](https://github.com/a2aproject/a2a-js)
- [etcd leases and gRPC naming](https://etcd.io/docs/v3.8/dev-guide/grpc_naming/)
- [Consul health checks](https://developer.hashicorp.com/consul/docs/reference/service/health-check)
- [Consul blocking queries](https://developer.hashicorp.com/consul/api-docs/features/blocking)
