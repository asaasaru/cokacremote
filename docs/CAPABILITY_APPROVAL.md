# Capability Approval Layer

This module adds a bounded authorization model on top of coka without turning user approval into unrestricted remote shell access.

## Security model

Decisions are evaluated in this order:

1. `HARD_DENY`
2. `ALWAYS_ALLOW`
3. active human-issued capability grant
4. `APPROVAL_REQUIRED`
5. default deny

A grant is valid only when all of the following match:

- provider
- project ID
- capability
- path constraints, if present
- command executable allowlist, if present
- network target allowlist, if present
- TTL
- max-use budget
- not revoked

The same MCP client must never be able to mint its own grant. `ApprovalBroker.approveFromTrustedChannel()` is intentionally an internal API and must only be called from a non-MCP trusted approval surface, such as a local operator UI or local CLI protected outside the model-accessible sandbox.

## pine-tvauto profile

The initial profile is intentionally narrow.

Approval-required:

- read/write under `/Users/vicmac/DevMac/Biz/TVauto`
- host execution under that project for `git`, `node`, `npm`, `python`, `python3`, `pytest`
- TradingView application control
- CDP at `127.0.0.1:9229`
- TVmcp HTTP at `127.0.0.1:5300`

Hard deny even with an attempted grant:

- secret/keychain reads
- Docker socket access
- personal browser profiles
- real trading/order placement
- unrestricted host access

## Current source enforcement and deployment gate

As of the 2026-10-03.2 control-plane contract, the source tree enforces the approval boundary directly:

1. OAuth requires a dedicated `MCP_OAUTH_APPROVAL_KEY`; it never falls back to `MCP_AUTH_TOKEN`, and the two values must differ when both are configured.
2. The approval form accepts only the exact decisions `approve` and `deny`; unknown values fail closed with no grant.
3. Approval pages are sent with `no-store`/no-cache headers.
4. Pending requests are transitioned to `expired` when read after their TTL and cannot be approved or denied afterward.
5. The generic `coka-base` profile creates host approval rules only inside operator-configured `MCP_CAPABILITY_HOST_ROOTS`; outside those roots the policy is default deny.
6. Bounded command execution requires a logical-name to absolute-binary mapping in `MCP_BOUNDED_EXECUTABLE_PATHS_JSON`; unpinned executable names are rejected before a grant can be consumed.

Deployment is complete only when production environment values are set, the service is restarted from this revision, `/health` reports the expected control-plane contract, and the bounded regression suite passes. Approval remains a narrowly scoped capability, never a global bypass.


## Host bridge execution ticket

The live Mac bridge must not trust a grant ID supplied by an MCP client. A grant is a control-plane object, not an execution credential.

For each approved host action, the hardened gateway should:

1. evaluate the exact action against the active human grant and atomically consume one grant use;
2. build an action digest over subject, project, capability, path/command/network target;
3. issue a short-lived Ed25519-signed execution ticket (recommended TTL: 30 seconds, maximum 60 seconds);
4. send the action plus ticket to the Mac bridge;
5. have the Mac bridge verify the signature with a pinned public key, verify the action digest and expiry, and reject replayed ticket IDs;
6. execute only the already-allowlisted operation;
7. emit an audit result.

The signing private key belongs only to the hardened control plane. The Mac bridge needs only the public key. Do not store either deployment key in the repository or sandbox.

This double enforcement means an MCP client cannot convert a previously approved grant into a different path, command, port, project, or capability, and captured tickets cannot be replayed.


## Mandatory host-side canonicalization

The hardened Mac bridge is a second policy boundary. It must independently enforce the signed request before any host action.

For filesystem actions it must resolve both the approved root and requested target with the host OS equivalent of `realpath()`, verify that the resolved target remains inside the resolved approved root, and reject symlink escapes, device/special files, and unexpected object types.

For command execution, requests must use bare executable names only. The Mac bridge must map each approved name to a fixed operator-owned absolute binary path rather than resolving through a model-controlled `PATH`, working directory, alias, wrapper, or project file. The exact argv approved by the human must match the argv covered by the signed action ticket.

These host-side checks remain mandatory even when the gateway already validated the request.

## Live rollout hardening

The live capability approval surface must use a human-only operator key unavailable to MCP tools, the executor, project files, or the model. The current source enforces a dedicated approval key, strict approve/deny parsing, expiry refresh, no-store approval responses, explicit host-root bounds, and absolute executable pinning. Approval attempts should remain rate-limited at the hardened gateway. Any deployment that omits `MCP_CAPABILITY_HOST_ROOTS` or the required entries in `MCP_BOUNDED_EXECUTABLE_PATHS_JSON` must fail closed rather than widening access.
