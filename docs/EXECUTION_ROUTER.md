# Execution Router and Provider Failover

This layer sits **after** coka capability approval. It never widens an approved task.

## Model

Antigravity is not the system of record and is not a required transport. It is an optional AgentCore/CPAA execution provider.

Logical backends:

- `agentcore.antigravity`
- `agentcore.native`
- `tv_bridge`
- `remote_desktop`
- `coka_local`

Health states:

- `HEALTHY`
- `DEGRADED`
- `AUTH_REQUIRED`
- `SUBSCRIPTION_REQUIRED`
- `RATE_LIMITED`
- `UNAVAILABLE`
- `POLICY_DENIED`
- `REPAIRING`
- `UNKNOWN`

## Default routing

Project read/write/test/exec:

1. AgentCore + Antigravity
2. AgentCore native
3. approved Remote Desktop

TradingView compile/backtest:

1. narrow TV runtime bridge
2. AgentCore native
3. approved Remote Desktop

TradingView GUI and AgentCore repair:

- approved Remote Desktop

coka sandbox work:

- coka local executor

## Critical safety rule

`POLICY_DENIED` is **not an availability failure**. The router must stop and must not try another backend to bypass it.

Likewise, coka capability decision `DENY` stops before backend routing and `APPROVAL_REQUIRED` stops until the human approval flow completes.

## Antigravity failure semantics

- `AUTH_REQUIRED`: circuit opens immediately, eligible work may route to another backend, credentials/MFA remain human-entered, then AgentCore status + CPAA canary are required before restoration.
- `SUBSCRIPTION_REQUIRED`: provider remains disabled until manual restoration; work continues through other backends.
- `RATE_LIMITED`: route around it temporarily and allow one half-open health/canary attempt after retry time.
- `UNAVAILABLE`: repeated transient failures open the circuit.
- provider/hook errors should isolate the affected provider/plugin rather than weakening global permissions.

## Remote Desktop role

Remote Desktop is a recovery/bootstrap/GUI transport, not an unrestricted policy bypass. When AgentCore is unavailable, use authorized Remote Desktop only to repair/start/register AgentCore and then return to AgentCore for normal work.

## Runtime integration boundary

This branch implements deterministic routing, health, circuit-breaker, and recovery planning only. It does **not** pretend that AgentCore, Antigravity, Remote Desktop, or TV Bridge are connected.

Live adapters must report verified health into `BackendHealthRegistry`. They must not allow an MCP caller to self-report a backend as healthy or to mutate policy state.


## Outcome classification

Live adapters should convert verified provider/transport observations through a conservative classification layer before updating the health registry.

Structured error codes are preferred. A bare HTTP 403 is **not** automatically treated as `POLICY_DENIED`; explicit policy evidence such as `OUTSIDE_APPROVED_WORKSPACE` or `SCOPE_DENIED` is required. Unknown failures degrade the backend instead of inventing an authentication, subscription, or policy cause.

This prevents the router from either bypassing a real policy denial or unnecessarily disabling fallback because of an ambiguous provider error.


## Trusted health ingestion

External executors do not become healthy merely because an MCP caller says so. A trusted local adapter or sidecar can report verified observations to:

`POST /internal/backend-health`

The route is disabled unless `MCP_BACKEND_HEALTH_KEY` is configured. Reports must provide that separate secret in the `x-coka-health-key` header. The route accepts only external backends (`agentcore.antigravity`, `agentcore.native`, `remote_desktop`, `tv_bridge`); reporters cannot override `coka_local`.

The HTTP route feeds observations through `classifyBackendObservation()`, updates `BackendHealthRegistry`, and advances the backend circuit breaker. It is intentionally separate from MCP authentication and capability grants.

## Capability enforcement at the host boundary

Routing is not the security boundary. For managed deployments, set:

```env
MCP_CAPABILITY_MODE=bounded
MCP_CAPABILITY_PROFILE=pine-tvauto
MCP_CAPABILITY_PROJECT=vic-tvauto
```

`legacy` exists only for backward compatibility. In bounded mode:

- file reads/writes are checked against the authenticated MCP client, configured project/profile, exact resolved path, and active grants before touching the host;
- destructive move/remove operations require a permitted workspace write or a `destructive.fs` grant;
- `exec_command` and `run_script` are disabled because arbitrary shell/script text cannot be safely represented by an exact argv grant;
- `exec_argv` directly spawns one bare executable with an explicit argument vector and no shell expansion;
- `apply_patch` is disabled because a unified patch can reference paths outside the approved root;
- process sessions started by `exec_argv` are bound to the authenticated subject for follow-up reads/stdin/termination;
- `execution_route` is a non-consuming preview; the actual file/exec action consumes the bounded grant.

The `pine-tvauto` profile keeps TradingView and TVauto host access approval-bound. Its resilient CDP target set is limited to `127.0.0.1:9229`, `:9333`, and `:9222`; the REST bridge is limited to `127.0.0.1:5300`. TVauto destructive filesystem and package-install actions are also approval-bound rather than permanently denied.

`GET /health` exposes `capabilityMode`, `capabilityProfileId`, `capabilityProjectId`, and reports `unrestrictedHostAccess=false` when bounded enforcement is active.
