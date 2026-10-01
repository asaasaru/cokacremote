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
