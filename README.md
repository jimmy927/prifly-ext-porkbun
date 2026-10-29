# prifly-ext-porkbun

A prifly extension: Porkbun domains and DNS from any session. You ask in plain
words ("list my domains", "is prifly.app free", "add an A record for api
pointing at 1.2.3.4") and the session does it through the `porkbun_*` tools,
as your own Porkbun account.

- Reads run at once. Every write first shows a confirm card: one sentence on
  what will happen, the record or purchase in plain text (money in dollars),
  and the method, URL and JSON body folded under Details; Cancel sends nothing
  and the tool answers "Not done: you cancelled".
- No launcher, board, chip or panel. The one thing it shows is a status line
  in Settings → Extensions: "Connected · jimmy · 7 domains", read again at
  most every 15 minutes, or "Not set up: add a `porkbun` entry to prifly's
  vault".
- The session instructions it adds to every session are `prompt.md`.

## Set up

1. In Settings → Extensions, enable **Porkbun**.
2. On porkbun.com/account/api create an API key (`pk1_…`) and its secret
   (`sk1_…`), and switch **API access** on for each domain to use.
3. In Settings → Vault add an API-token entry named **`porkbun`** (level 1,
   the one an extension can read) whose token is both keys as JSON, with
   Porkbun's own field names:

   ```json
   {"apikey": "pk1_…", "secretapikey": "sk1_…"}
   ```

   (`pk1_…:sk1_…` is read too.) The extension reads the entry on every call
   and keeps nothing: keys are never written to a file, logged, shown on a
   card or returned by a tool; they travel only in the `X-API-Key` and
   `X-Secret-API-Key` headers. Without the entry every tool says what to add.

## Tools

| Tool                  | What it does                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `porkbun_domains`     | The account's domains, soonest expiry first: expiry, auto-renew, status, and whether API access is off. Optional `contains`, `expiringWithinDays`                                                                                                                   |
| `porkbun_dns_records` | A domain's records (id, name, type, TTL, priority, content); optional `name` and `type` filter                                                                                                                                                                      |
| `porkbun_check`       | Whether up to 25 names are free, and the price in dollars (registration and renewal)                                                                                                                                                                                |
| `porkbun_dns_change`  | Create, edit or delete one record — confirmed. An edit or delete finds the record by `id`, or by `name` + `type` when exactly one matches, and sends only the fields to change                                                                                      |
| `porkbun_api`         | Any other API v3 call: `method` GET or POST, `path`, `body`, `query`. A pure read runs at once; anything else — registering a domain, nameservers, URL forwarding, auto-renew, top-ups — is confirmed. `ssl/retrieve` (it returns the private key) is confirmed too |

Porkbun takes money in **US cents (pennies)**: `domain/create` wants `cost:
1108` for $11.08, equal to the price `porkbun_check` showed. The card shows the
dollars (`Cost: $11.08 (sent as 1108 cents)`), and a `cost`, `amount`,
`threshold` or `acknowledgedCost` that is not a whole number of cents is
refused before any card. Porkbun's errors (`{"status": "ERROR", "message":
…}`) come back as a sentence, "Porkbun error: Insufficient funds … (INSUFFICIENT_FUNDS)",
with Porkbun's own answer under it in `porkbun_api`.

## Verified against Porkbun

Checked on 2026-10-29 against Porkbun's OpenAPI spec for API v3 (version 3.65,
`https://porkbun.com/api/json/v3/spec`, the machine-readable form of
`https://porkbun.com/api/json/v3/documentation`; `https://porkbun.com/mcp` was
read for the tool names and says money is in cents). Base URL
`https://api.porkbun.com/api/json/v3`; auth by `X-API-Key` and
`X-Secret-API-Key` headers (or `apikey`/`secretapikey` in the body, which this
extension never uses). Paths and bodies used:

| Call                   | Path                                                                                                                                                                                                                                                                                      | Body                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| list domains           | `POST domain/listAll`                                                                                                                                                                                                                                                                     | `start` (pages of 1000), `nameContains`, `expiringWithinDays`; answer `domains[]` with `domain`, `status`, `expireDate`, `autoRenew`, `apiAccess` |
| a domain's records     | `POST dns/retrieve/{domain}`                                                                                                                                                                                                                                                              | none; answer `records[]` with `id`, `name` (fully qualified), `type`, `content`, `ttl`, `prio`, `notes`                                           |
| check one name         | `POST domain/checkDomain/{domain}`                                                                                                                                                                                                                                                        | none; answer `response` with `avail`, `price`, `additional.renewal.price` (dollars, strings)                                                      |
| check several          | `POST domain/checkDomain`                                                                                                                                                                                                                                                                 | `domains` (up to 25); answer `domains{}`, `unresolved[]`, `invalid[]`                                                                             |
| create a record        | `POST dns/create/{domain}`                                                                                                                                                                                                                                                                | `name` (relative, "" for the domain), `type`, `content`, `ttl`, `prio`, `notes`; answer `id`                                                      |
| edit a record          | `POST dns/edit/{domain}/{id}`                                                                                                                                                                                                                                                             | only the fields to change                                                                                                                         |
| delete a record        | `POST dns/delete/{domain}/{id}`                                                                                                                                                                                                                                                           | none                                                                                                                                              |
| status line            | `POST ping`                                                                                                                                                                                                                                                                               | none; answer `account`                                                                                                                            |
| `porkbun_api` examples | `POST domain/create/{domain}` (`cost` in pennies, `agreeToTerms` "yes", optional `payWith`, `dryRun`), `POST domain/updateNs/{domain}` (`ns[]`), `POST domain/updateAutoRenew/{domain}` (`status` on/off), `POST domain/addUrlForward/{domain}`, `POST account/topup` (`amount` in cents) |                                                                                                                                                   |

Not run against the live API: every test uses a mocked `fetch`, and nothing in
this repository makes a real write. Porkbun also has sandbox keys (`pk1_sb_…`)
that charge and change nothing, for trying it by hand.

## Checks

`bun test`, `bun run typecheck` (`tsc --noEmit`) and `bun run check` (biome).

## What is where

| File                     | What it is                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `prifly-extension.json`  | The manifest: the `porkbun` vault entry and the `prompt`                            |
| `prompt.md`              | The session instructions                                                            |
| `index.ts`               | What prifly imports: `activate(api)` registers the tools and starts the status line |
| `tools.ts`, `tools-*.ts` | The tools; `tools-common.ts` is what each does first                                |
| `credentials.ts`         | Reading the keys from the vault; scrubbing them from any text                       |
| `write.ts`               | The one road for a write: the confirm card, then the request                        |
| `status.ts`              | The status line                                                                     |
| `porkbun.ts`             | The only file that talks to Porkbun, through `fetch`                                |
| `test/`                  | Tests against a fake `api` and a fake Porkbun                                       |

Import prifly's types with `import type`: they are erased, so the host never
needs the package to run the extension.

## License and contributing

Source-available under the Functional Source License 1.1 with an Apache 2.0 future license (`LICENSE.md`): use it, change it and fix it freely, but not to offer a competing product. Each version becomes Apache 2.0 two years after its release.

Pull requests are welcome. Before one can be merged, its author signs the contributor agreement (`CLA.md`), which assigns the copyright in the contribution to The Startup Factory AB; the CLA bot asks for it on the pull request.
