import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BAD_ENTRY, NO_ENTRY, parseCreds, scrub } from "../credentials";
import { startStatus } from "../status";
import { MAX_ANSWER } from "../tools-common";
import { fakeApi } from "./fake-api";
import { setup } from "./harness";
import {
  installFetch,
  json,
  KEY,
  porkbunError,
  type Route,
  restoreFetch,
  SECRET,
  TOKEN,
} from "./porkbun-fake";

afterEach(restoreFetch);

const OWNED = [
  {
    domain: "prifly.dev",
    status: "ACTIVE",
    tld: "dev",
    expireDate: "2027-03-01 12:00:00",
    autoRenew: 1,
    apiAccess: 1,
  },
  {
    domain: "old-site.com",
    status: "ACTIVE",
    tld: "com",
    expireDate: "2026-12-24 00:00:00",
    autoRenew: 0,
    apiAccess: 0,
  },
];

describe("the vault entry", () => {
  test("JSON with Porkbun's field names, or key:secret", () => {
    expect(parseCreds(TOKEN)).toEqual({ apikey: KEY, secretapikey: SECRET });
    expect(parseCreds(`${KEY}:${SECRET}`)).toEqual({ apikey: KEY, secretapikey: SECRET });
    expect(parseCreds(`{"apikey": "${KEY}"}`)).toBeNull();
    expect(parseCreds("just one word")).toBeNull();
    expect(parseCreds("{broken")).toBeNull();
  });

  test("scrub removes both keys", () => {
    expect(scrub(`a ${KEY} b ${SECRET} c`, { apikey: KEY, secretapikey: SECRET })).toBe(
      "a [redacted] b [redacted] c",
    );
  });

  test("without the entry every tool says what to add, and nothing is sent", async () => {
    const { fake, calls } = setup([], { vault: null });
    const everyTool = [
      ["porkbun_domains", {}],
      ["porkbun_dns_records", { domain: "prifly.dev" }],
      ["porkbun_check", { domains: ["prifly.app"] }],
      [
        "porkbun_dns_change",
        { action: "create", domain: "prifly.dev", type: "A", content: "1.2.3.4" },
      ],
      ["porkbun_api", { method: "GET", path: "ping" }],
    ] as const;
    for (const [name, args] of everyTool) expect(await fake.callTool(name, args)).toBe(NO_ENTRY);
    expect(NO_ENTRY).toContain("`porkbun`");
    expect(NO_ENTRY).toContain("apikey");
    expect(NO_ENTRY).toContain("secretapikey");
    expect(calls).toHaveLength(0);
    expect(fake.confirms).toHaveLength(0);
  });

  test("an entry in the wrong form is said, without echoing it", async () => {
    const { fake, calls } = setup([], { vault: "not-the-keys-at-all" });
    const text = await fake.callTool("porkbun_domains", {});
    expect(text).toBe(BAD_ENTRY);
    expect(text).not.toContain("not-the-keys");
    expect(calls).toHaveLength(0);
  });
});

describe("porkbun_domains", () => {
  const route: Route = {
    path: /^domain\/listAll$/,
    answer: () => json({ status: "SUCCESS", count: 2, domains: OWNED }),
  };

  test("lists domains with expiry and auto-renew, flagging one the API cannot touch", async () => {
    const { fake, calls } = setup([route]);
    const text = await fake.callTool("porkbun_domains", {});
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.porkbun.com/api/json/v3/domain/listAll");
    expect(calls[0]?.headers["x-api-key"]).toBe(KEY);
    expect(calls[0]?.headers["x-secret-api-key"]).toBe(SECRET);
    expect(calls[0]?.body).toEqual({ start: 0 });
    expect(text).toBe(
      [
        // The answer lists prifly.dev first; the tool puts the sooner expiry first.
        "old-site.com | expires 2026-12-24 00:00:00 | auto-renew off | ACTIVE | API access off (turn it on in Porkbun to change its DNS)",
        "prifly.dev | expires 2027-03-01 12:00:00 | auto-renew on | ACTIVE",
      ].join("\n"),
    );
    expect(fake.confirms).toHaveLength(0);
  });

  test("filters go in the body", async () => {
    const { fake, calls } = setup([route]);
    await fake.callTool("porkbun_domains", { contains: "prifly", expiringWithinDays: 30 });
    expect(calls[0]?.body).toEqual({ nameContains: "prifly", expiringWithinDays: 30, start: 0 });
  });

  test("pages of 1000 are followed", async () => {
    const page = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        domain: `d${i}.com`,
        expireDate: "2027-01-01",
        autoRenew: 1,
        apiAccess: 1,
        status: "ACTIVE",
      }));
    const { fake, calls } = setup([
      {
        path: /^domain\/listAll$/,
        answer: (call) =>
          json({
            status: "SUCCESS",
            domains: (call.body as { start: number }).start === 0 ? page(1000) : page(3),
          }),
      },
    ]);
    const text = await fake.callTool("porkbun_domains", {});
    expect(calls.map((each) => (each.body as { start: number }).start)).toEqual([0, 1000]);
    // 1003 lines are too long for the tool's text: the start is kept and the cut is said.
    expect(text).toMatch(/^d0\.com \| expires 2027-01-01/);
    expect(text).toContain("more characters cut");
  });

  test("an answer too long for the tool goes to the scratchpad, said where", async () => {
    const scratchpad = mkdtempSync(join(tmpdir(), "porkbun-pad-"));
    try {
      const many = Array.from({ length: 400 }, (_, i) => ({
        domain: `a-rather-long-domain-name-${i}.example.com`,
        expireDate: "2027-01-01",
        autoRenew: 1,
        apiAccess: 1,
        status: "ACTIVE",
      }));
      const { fake } = setup(
        [{ path: /^domain\/listAll$/, answer: () => json({ status: "SUCCESS", domains: many }) }],
        { scratchpad },
      );
      const text = await fake.callTool("porkbun_domains", {});
      expect(text.length).toBeLessThan(MAX_ANSWER + 300);
      const saved = /the whole answer is in (.+)\)$/.exec(text)?.[1];
      expect(saved).toBeDefined();
      expect(readFileSync(saved ?? "", "utf8").split("\n")).toHaveLength(400);
    } finally {
      rmSync(scratchpad, { recursive: true, force: true });
    }
  });

  test("Porkbun's error is said readably, and no key is in it", async () => {
    const { fake } = setup([
      {
        path: /^domain\/listAll$/,
        answer: () => porkbunError(`Invalid API key: ${KEY} / ${SECRET}`, "INVALID_API_KEY", 403),
      },
    ]);
    const text = await fake.callTool("porkbun_domains", {});
    expect(text).toBe("Porkbun error: Invalid API key: [redacted] / [redacted] (INVALID_API_KEY)");
  });

  test("a domain without API access says where to switch it on", async () => {
    const { fake } = setup([
      {
        path: /^dns\/retrieve\//,
        answer: () => porkbunError("Domain is not opted in to API access.", "API_ACCESS_DISABLED"),
      },
    ]);
    expect(await fake.callTool("porkbun_dns_records", { domain: "prifly.dev" })).toBe(
      "Porkbun error: Domain is not opted in to API access. (API_ACCESS_DISABLED) Turn on Opt In All Domains at porkbun.com/account/api (it covers every domain, future ones too), or switch API Access on in that domain's Details under Domain Management.",
    );
  });

  test("an unreachable Porkbun is said", async () => {
    const { fake } = setup([]);
    globalThis.fetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND api.porkbun.com");
    }) as unknown as typeof fetch;
    expect(await fake.callTool("porkbun_domains", {})).toBe(
      "Could not reach Porkbun: getaddrinfo ENOTFOUND api.porkbun.com",
    );
  });
});

describe("porkbun_check", () => {
  test("one name uses the single check and says price and renewal", async () => {
    const { fake, calls } = setup([
      {
        path: /^domain\/checkDomain\/prifly\.app$/,
        answer: () =>
          json({
            status: "SUCCESS",
            response: {
              avail: "yes",
              type: "registration",
              price: "11.08",
              firstYearPromo: "no",
              regularPrice: "11.08",
              premium: "no",
              minDuration: 1,
              additional: { renewal: { type: "renewal", price: "15.20" } },
            },
          }),
      },
    ]);
    const text = await fake.callTool("porkbun_check", { domains: ["Prifly.app"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.porkbun.com/api/json/v3/domain/checkDomain/prifly.app");
    expect(text).toBe("prifly.app: available, $11.08 a year, renews at $15.20");
  });

  test("several names go in one bulk call; taken, owned, premium and unresolved are told apart", async () => {
    const { fake, calls } = setup([
      {
        path: /^domain\/checkDomain$/,
        answer: () =>
          json({
            status: "SUCCESS",
            checked: 3,
            domains: {
              "prifly.app": {
                avail: "yes",
                price: "4.00",
                firstYearPromo: "yes",
                regularPrice: "14.00",
                minDuration: 1,
              },
              "prifly.com": { avail: "no" },
              "mine.dev": { avail: "no", inYourAccount: true },
              "fancy.ai": { avail: "yes", price: "999.00", premium: "yes", minDuration: 2 },
            },
            unresolved: ["slow.de"],
            invalid: [{ domain: "bad", reason: "not a domain" }],
          }),
      },
    ]);
    const text = await fake.callTool("porkbun_check", {
      domains: ["prifly.app", "prifly.com", "mine.dev", "fancy.ai", "slow.de"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.porkbun.com/api/json/v3/domain/checkDomain");
    expect(calls[0]?.body).toEqual({
      domains: ["prifly.app", "prifly.com", "mine.dev", "fancy.ai", "slow.de"],
    });
    expect(text).toBe(
      [
        "prifly.app: available, $4.00 a year first-year promo, regular $14.00",
        "prifly.com: taken",
        "mine.dev: already in your account",
        "fancy.ai: available, $999.00 for 2 years, premium (Porkbun does not register premium names through the API)",
        "slow.de: the registry did not answer; ask again",
        'Not checkable: {"domain":"bad","reason":"not a domain"}',
      ].join("\n"),
    );
  });

  test("bad input is refused before any request", async () => {
    const { fake, calls } = setup([]);
    expect(await fake.callTool("porkbun_check", { domains: ["nope"] })).toContain(
      "not a domain name",
    );
    expect(await fake.callTool("porkbun_check", { domains: [] })).toContain("Give `domains`");
    expect(calls).toHaveLength(0);
  });

  test("a rate limit or other Porkbun error is said", async () => {
    const { fake } = setup([
      {
        path: /^domain\/checkDomain\//,
        answer: () => porkbunError("Check limit exceeded.", "RATE_LIMIT_EXCEEDED", 429),
      },
    ]);
    expect(await fake.callTool("porkbun_check", { domains: ["prifly.app"] })).toBe(
      "Porkbun error: Check limit exceeded. (RATE_LIMIT_EXCEEDED)",
    );
  });
});

describe("the status line", () => {
  test("says what to add, then who is connected and how many domains", async () => {
    const empty = fakeApi({ vault: null });
    const none = startStatus(empty.api, () => () => undefined);
    await none.refresh();
    expect(empty.statuses.at(-1)).toBe("Not set up: add a `porkbun` entry to prifly's vault");
    none.stop();

    const calls = installFetch([
      {
        path: /^ping$/,
        answer: () => json({ status: "SUCCESS", yourIp: "1.2.3.4", account: "jimmy" }),
      },
      { path: /^domain\/listAll$/, answer: () => json({ status: "SUCCESS", domains: OWNED }) },
    ]);
    const ready = fakeApi({ vault: TOKEN });
    const line = startStatus(ready.api, () => () => undefined);
    await line.refresh();
    expect(ready.statuses.at(-1)).toBe("Connected · jimmy · 2 domains");
    expect(calls.map((each) => each.path)).toContain("ping");
    expect(ready.statuses.join("\n")).not.toMatch(new RegExp(`${KEY}|${SECRET}`));
    line.stop();
  });
});
