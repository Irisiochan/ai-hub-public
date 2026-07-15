# Memory Vault service

This directory contains the MCP memory service bundled with ai-hub. Service code
and private memory data are deliberately separated:

- tracked service/template code lives in `memory-vault/`;
- runtime Markdown lives in the ignored root directory `vault-data/`;
- Docker exposes the service only to the internal Compose network.

The root Compose file initializes `vault-data/` on first boot and connects
ai-hub to `http://memory-vault:8900/mcp` automatically.

When the Python service is started directly without `MEMORY_VAULT_PATH`, it
uses the ai-hub root directory `vault-data/` and initializes missing files from
the bundled template. It never falls back to writing private Markdown under
the tracked `memory-vault/` source directory.

## Optional private Git synchronization

Local persistence works without Git. To sync memories between devices, make
`vault-data/` an independent **private** Git repository with its own remote and
author identity. The service detects `vault-data/.git` and then performs its
existing pull/commit/push workflow. It never falls through to the public
ai-hub repository.

Never commit `vault-data/` to the public source repository.
