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

## Next integration step

The live coka deployment currently has stronger container separation than this repository. Do not deploy this repository over the live stack.

Instead:

1. instantiate the policy engine in the gateway or host-bridge boundary;
2. create pending approval requests when a protected action is requested;
3. expose approval only on a trusted operator surface unavailable to MCP tools;
4. pass the resulting bounded grant to the host bridge;
5. enforce the grant again at the host bridge before execution;
6. append an immutable audit event containing request ID, grant ID, project, provider, capability, bounded target, decision, timestamp, and outcome.

This keeps approval as a narrowly scoped capability, not a global bypass.
