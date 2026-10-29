import { afterEach, describe, expect, test } from "bun:test";
import { fullName, subOf } from "../tools-dns";
import { CANCELLED } from "../write";
import { setup } from "./harness";
import { json, KEY, porkbunError, type Route, restoreFetch, SECRET } from "./porkbun-fake";

afterEach(restoreFetch);

const WWW = {
  id: "101",
  name: "www.prifly.dev",
  type: "A",
  content: "1.1.1.1",
  ttl: "600",
  prio: null,
  notes: null,
};
const MX = {
  id: "102",
  name: "prifly.dev",
  type: "MX",
  content: "mx.mail.example",
  ttl: "600",
  prio: "10",
  notes: null,
};
const TXT_A = {
  id: "103",
  name: "prifly.dev",
  type: "TXT",
  content: "v=spf1 -all",
  ttl: "600",
  prio: null,
  notes: null,
};
const TXT_B = {
  id: "104",
  name: "prifly.dev",
  type: "TXT",
  content: "hello",
  ttl: "600",
  prio: null,
  notes: "kept",
};

/** A domain with a few records, and the three DNS writes answering as Porkbun does. */
function routes(records = [WWW, MX, TXT_A, TXT_B]): Route[] {
  return [
    {
      path: /^dns\/retrieve\/prifly\.dev$/,
      answer: () => json({ status: "SUCCESS", cloudflare: "disabled", records }),
    },
    { path: /^dns\/create\/prifly\.dev$/, answer: () => json({ status: "SUCCESS", id: "555" }) },
    { path: /^dns\/edit\/prifly\.dev\/\d+$/, answer: () => json({ status: "SUCCESS" }) },
    { path: /^dns\/delete\/prifly\.dev\/\d+$/, answer: () => json({ status: "SUCCESS" }) },
  ];
}

describe("names", () => {
  test("relative, apex and fully qualified names", () => {
    expect(subOf("www", "prifly.dev")).toBe("www");
    expect(subOf("@", "prifly.dev")).toBe("");
    expect(subOf("prifly.dev", "prifly.dev")).toBe("");
    expect(subOf("API.prifly.dev.", "prifly.dev")).toBe("api");
    expect(subOf("*", "prifly.dev")).toBe("*");
    // Ends with the domain's text but is not inside it: it is relative.
    expect(subOf("fooprifly.dev", "prifly.dev")).toBe("fooprifly.dev");
    expect(fullName("", "prifly.dev")).toBe("prifly.dev");
    expect(fullName("www", "prifly.dev")).toBe("www.prifly.dev");
  });
});

describe("porkbun_dns_records", () => {
  test("reads the domain's records with the keys in headers, never in the body", async () => {
    const { fake, calls } = setup(routes());
    const text = await fake.callTool("porkbun_dns_records", { domain: "Prifly.dev" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.porkbun.com/api/json/v3/dns/retrieve/prifly.dev");
    expect(calls[0]?.headers["x-api-key"]).toBe(KEY);
    expect(calls[0]?.headers["x-secret-api-key"]).toBe(SECRET);
    expect(JSON.stringify(calls[0]?.body)).not.toContain(KEY);
    expect(text).toBe(
      [
        "id 101 | www.prifly.dev A 600 1.1.1.1",
        "id 102 | prifly.dev MX 600 prio 10 mx.mail.example",
        "id 103 | prifly.dev TXT 600 v=spf1 -all",
        "id 104 | prifly.dev TXT 600 hello (kept)",
      ].join("\n"),
    );
    expect(fake.confirms).toHaveLength(0);
  });

  test("filters by name and type", async () => {
    const { fake } = setup(routes());
    expect(await fake.callTool("porkbun_dns_records", { domain: "prifly.dev", name: "www" })).toBe(
      "id 101 | www.prifly.dev A 600 1.1.1.1",
    );
    expect(
      await fake.callTool("porkbun_dns_records", { domain: "prifly.dev", name: "@", type: "txt" }),
    ).toContain("id 103 | prifly.dev TXT");
    expect(await fake.callTool("porkbun_dns_records", { domain: "prifly.dev", name: "nope" })).toBe(
      "No DNS records in prifly.dev match.",
    );
  });

  test("a bad domain is refused before any request", async () => {
    const { fake, calls } = setup(routes());
    expect(await fake.callTool("porkbun_dns_records", { domain: "not a domain" })).toContain(
      "not a domain name",
    );
    expect(await fake.callTool("porkbun_dns_records", {})).toContain("Give `domain`");
    expect(calls).toHaveLength(0);
  });
});

describe("porkbun_dns_change", () => {
  test("create: an A record, confirmed, posted with the name relative to the domain", async () => {
    const { fake, calls } = setup(routes());
    const text = await fake.callTool("porkbun_dns_change", {
      action: "create",
      domain: "prifly.dev",
      name: "api",
      type: "a",
      content: "3.3.3.3",
      ttl: 600,
    });
    const body = { name: "api", type: "A", content: "3.3.3.3", ttl: 600 };
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.porkbun.com/api/json/v3/dns/create/prifly.dev");
    expect(calls[0]?.body).toEqual(body);
    expect(calls[0]?.headers["x-api-key"]).toBe(KEY);
    const card = fake.confirms[0];
    expect(fake.confirms).toHaveLength(1);
    expect(card?.title).toBe("Add a DNS record");
    // One plain sentence: no URL, no JSON, no line breaks.
    expect(card?.summary).toBe(
      "Add an A record for api.prifly.dev pointing to 3.3.3.3 in prifly.dev.",
    );
    expect(card?.summary).not.toMatch(/https?:|[{}\n]/);
    // The record is in plain text in `content`.
    expect(card?.content).toBe(
      "Domain: prifly.dev\n\nNew record\nName: api.prifly.dev\nType: A\nTTL: 600 seconds\nValue: 3.3.3.3",
    );
    expect(card?.content).not.toMatch(/https?:|[{}]/);
    // The request, URL and JSON body, is only in `details`; the keys are in neither.
    expect(card?.details).toContain(
      `POST https://api.porkbun.com/api/json/v3/dns/create/prifly.dev\n\n${JSON.stringify(body, null, 2)}`,
    );
    for (const shown of [card?.summary, card?.content, card?.details])
      expect(`${shown}`).not.toMatch(new RegExp(`${KEY}|${SECRET}`));
    expect(text).toBe(
      "Porkbun accepted it (record 555): Add an A record for api.prifly.dev pointing to 3.3.3.3 in prifly.dev.",
    );
  });

  test("create at the apex: an MX record with a priority", async () => {
    const { fake, calls } = setup(routes());
    await fake.callTool("porkbun_dns_change", {
      action: "create",
      domain: "prifly.dev",
      type: "MX",
      content: "mx2.mail.example",
      prio: 20,
    });
    expect(calls[0]?.body).toEqual({ name: "", type: "MX", content: "mx2.mail.example", prio: 20 });
    expect(fake.confirms[0]?.summary).toBe(
      "Add an MX record for prifly.dev with data mx2.mail.example in prifly.dev.",
    );
    expect(fake.confirms[0]?.content).toContain("TTL: Porkbun's default for the account");
    expect(fake.confirms[0]?.content).toContain("Priority: 20");
  });
});

describe("porkbun_dns_change edits and deletes", () => {
  test("edit: finds the record by name + type, sends only what changes, shows before and after", async () => {
    const { fake, calls } = setup(routes());
    const text = await fake.callTool("porkbun_dns_change", {
      action: "edit",
      domain: "prifly.dev",
      name: "www",
      type: "A",
      content: "2.2.2.2",
      ttl: 300,
    });
    expect(calls.map((each) => each.path)).toEqual([
      "dns/retrieve/prifly.dev",
      "dns/edit/prifly.dev/101",
    ]);
    expect(calls[1]?.body).toEqual({ content: "2.2.2.2", ttl: 300 });
    const card = fake.confirms[0];
    expect(card?.title).toBe("Change a DNS record");
    expect(card?.summary).toBe(
      "In prifly.dev, replace an A record for www.prifly.dev pointing to 1.1.1.1 with an A record for www.prifly.dev pointing to 2.2.2.2.",
    );
    expect(card?.content).toBe(
      [
        "Domain: prifly.dev",
        "",
        "Current record (replaced)\nName: www.prifly.dev\nType: A\nTTL: 600 seconds\nValue: 1.1.1.1",
        "",
        "New record\nName: www.prifly.dev\nType: A\nTTL: 300 seconds\nValue: 2.2.2.2",
      ].join("\n"),
    );
    expect(text).toContain("Porkbun accepted it:");
  });

  test("delete: by id, the record to delete is shown", async () => {
    const { fake, calls } = setup(routes());
    await fake.callTool("porkbun_dns_change", {
      action: "delete",
      domain: "prifly.dev",
      id: "104",
    });
    expect(calls[1]?.url).toBe("https://api.porkbun.com/api/json/v3/dns/delete/prifly.dev/104");
    expect(calls[1]?.body).toEqual({});
    const card = fake.confirms[0];
    expect(card?.title).toBe("Delete a DNS record");
    expect(card?.summary).toBe(
      "Delete a TXT record for prifly.dev with data hello from prifly.dev.",
    );
    expect(card?.content).toBe(
      "Domain: prifly.dev\n\nRecord to delete\nName: prifly.dev\nType: TXT\nTTL: 600 seconds\nValue: hello\nNotes: kept",
    );
  });

  test("two records match: the session is asked for the id, and no card is shown", async () => {
    const { fake, calls } = setup(routes());
    const text = await fake.callTool("porkbun_dns_change", {
      action: "delete",
      domain: "prifly.dev",
      name: "@",
      type: "TXT",
    });
    expect(text).toContain("2 records match; pass the `id`");
    expect(text).toContain("id 103 |");
    expect(text).toContain("id 104 |");
    expect(fake.confirms).toHaveLength(0);
    expect(calls.every((each) => each.path.startsWith("dns/retrieve"))).toBe(true);
  });

  test("a record that is not there is said, and nothing is asked or sent", async () => {
    const { fake, calls } = setup(routes());
    const text = await fake.callTool("porkbun_dns_change", {
      action: "edit",
      domain: "prifly.dev",
      name: "gone",
      type: "A",
      content: "9.9.9.9",
    });
    expect(text).toBe("No A record named gone.prifly.dev in prifly.dev.");
    expect(fake.confirms).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });
});

describe("porkbun_dns_change that sends nothing, or fails", () => {
  test("cancelled: nothing is sent", async () => {
    const { fake, calls } = setup(routes(), { confirm: false });
    const created = await fake.callTool("porkbun_dns_change", {
      action: "create",
      domain: "prifly.dev",
      name: "api",
      type: "A",
      content: "3.3.3.3",
    });
    expect(created).toBe(CANCELLED);
    expect(created).toBe("Not done: you cancelled");
    expect(calls).toHaveLength(0);
    const deleted = await fake.callTool("porkbun_dns_change", {
      action: "delete",
      domain: "prifly.dev",
      id: "101",
    });
    expect(deleted).toBe(CANCELLED);
    // Only the read that finds the record went out.
    expect(calls.map((each) => each.method + each.path)).toEqual(["POSTdns/retrieve/prifly.dev"]);
  });

  test("a prifly without confirm cards sends nothing", async () => {
    const { fake, calls } = setup(routes(), { confirm: null });
    const text = await fake.callTool("porkbun_dns_change", {
      action: "create",
      domain: "prifly.dev",
      type: "A",
      content: "3.3.3.3",
    });
    expect(text).toContain("cannot show a confirm card");
    expect(calls).toHaveLength(0);
  });

  test("Porkbun's error is said readably", async () => {
    const { fake } = setup([
      {
        path: /^dns\/create\//,
        answer: () =>
          porkbunError("Create error: We were unable to create the DNS record.", "CREATE_FAILED"),
      },
    ]);
    const text = await fake.callTool("porkbun_dns_change", {
      action: "create",
      domain: "prifly.dev",
      type: "A",
      content: "3.3.3.3",
    });
    expect(text).toBe(
      "Porkbun error: Create error: We were unable to create the DNS record. (CREATE_FAILED)",
    );
    expect(fake.confirms).toHaveLength(1);
  });

  test("a warning from Porkbun reaches the session", async () => {
    const { fake } = setup([
      {
        path: /^dns\/create\//,
        answer: () =>
          json({
            status: "SUCCESS",
            id: "9",
            warnings: ["Domain is not using Porkbun nameservers."],
          }),
      },
    ]);
    const text = await fake.callTool("porkbun_dns_change", {
      action: "create",
      domain: "prifly.dev",
      type: "A",
      content: "1.2.3.4",
    });
    expect(text).toContain("Porkbun warns: Domain is not using Porkbun nameservers.");
  });

  test("missing pieces are refused before any request", async () => {
    const { fake, calls } = setup(routes());
    expect(
      await fake.callTool("porkbun_dns_change", { action: "upsert", domain: "prifly.dev" }),
    ).toContain("`action`");
    expect(
      await fake.callTool("porkbun_dns_change", {
        action: "create",
        domain: "prifly.dev",
        name: "a",
      }),
    ).toContain("Give `type` and `content`");
    expect(
      await fake.callTool("porkbun_dns_change", {
        action: "edit",
        domain: "prifly.dev",
        name: "a",
        type: "A",
      }),
    ).toContain("Give what to change");
    expect(
      await fake.callTool("porkbun_dns_change", { action: "delete", domain: "prifly.dev" }),
    ).toContain("Name the record");
    expect(calls).toHaveLength(0);
  });
});
