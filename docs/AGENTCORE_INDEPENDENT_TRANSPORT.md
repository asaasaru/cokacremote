# AgentCore Independent Transport

## Goal

Normal Mac/Windows project reads, tests, and approved CPAA work must not depend on Remote Desktop Commander relay state.

Runtime path:

`ChatGPT → coka execution_request → AgentCore broker → outbound AgentCore worker → local CPAA → evidence → execution_status`

RDC is bootstrap/repair/GUI fallback only.

## Coka deployment

Set a JSON object of operator-generated per-device secrets in `MCP_AGENTCORE_DEVICE_KEYS_JSON`. Never commit a real value.

Example shape only:

```json
{"vicMac.local":"<local-secret>","m":"<local-secret>"}
```

The broker is disabled when this variable is absent.

## Device worker

AgentCore 0.2.7-independent-transport adds `bootstrap/run_broker_client.py`.

Each device supplies locally protected runtime variables:

- `AGENTCORE_BROKER_URL=https://mcp.asarubiya.com`
- `AGENTCORE_BROKER_DEVICE_ID`
- `AGENTCORE_BROKER_KEY`
- `AGENTCORE_BROKER_PROJECTS_JSON`
- optional `AGENTCORE_BROKER_POLL_SECONDS`
- optional `AGENTCORE_PLAN_ROOT`

The worker only makes outbound HTTPS requests. It exposes no inbound port and no raw shell.

## Reads

Only fixed operations are supported: `stat`, `sha256`, bounded `text`, and `git_status`. Project root/path validation happens independently on coka and the device.

## Mutations

Mutations must carry the canonical plan basename/SHA, bounded instruction, and approved test IDs. The worker verifies the plan locally and submits to the existing AgentCore CPAA executor; it does not bypass the local manifest, approval envelope, test, or AGY execution controls.

## Tool-catalog contract and stale-client recovery

The control-plane contract is versioned independently from process health. For revision `2026-10-03.2`, the stable control-plane surface is:

- `execution_request`
- `execution_status`
- `execution_route`
- `execution_recovery`

`/health` and `execution_status` expose the contract revision/fingerprint. Any inventory or schema change to those tools must bump `CONTROL_PLANE_CONTRACT_REVISION`, update the integration expectations, and bump the `agentcore-control` plugin URL `schema=` identity in the same release. A ChatGPT conversation that still exposes an older catalog is `CONTROL_PLANE_TOOL_CATALOG_STALE`; that state is not evidence that Mac, Windows, AgentCore, CPAA, or the broker is offline. This stateless server does not claim hot tool-list refresh support for an already cached conversation. Do not substitute raw RDC merely because a client cached an older tool catalog. Use the current `agentcore-control` plugin/release or a refreshed conversation connection; RDC remains bootstrap/repair/GUI fallback only.

## Completion gate

With RDC intentionally stopped, verify both Mac and Windows can register and complete a fresh bounded request. For TVauto specifically, verify `config.yaml`, `errorHandling.md`, and `git_status` through AgentCore, then run one reversible approved CPAA mutation canary on each OS. Also verify that the server-reported control-plane revision/fingerprint matches the `agentcore-control` plugin schema identity before declaring the control plane current.
