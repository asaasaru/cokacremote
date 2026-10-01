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

## Completion gate

With RDC intentionally stopped, verify both Mac and Windows can register and complete a fresh bounded request. For TVauto specifically, verify `config.yaml`, `errorHandling.md`, and `git_status` through AgentCore, then run one reversible approved CPAA mutation canary on each OS.
