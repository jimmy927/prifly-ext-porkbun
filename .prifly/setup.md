---
setup:
  - bun install --frozen-lockfile
---

A prifly extension (Porkbun domains and DNS), built and tested with Bun. The gate, set in
git config `prifly.gate`, is `bun test`, `bun x biome check .` and `bun x tsc --noEmit`.

The install reads `bun.lock` and never rewrites it. `.gitattributes` keeps files LF on
checkout, which biome needs on a Windows machine with `core.autocrlf=true`.

Relies on `bun` being on PATH. Tests mock `fetch` and never call the live Porkbun API, so
no vault entry or network credentials are needed to run them.
