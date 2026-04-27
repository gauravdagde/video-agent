import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isMagicDoc,
  loadMagicDoc,
  updateMagicDoc,
} from "./magicDocs.ts";

const TMP = path.join(
  process.env.TMPDIR ?? "/tmp",
  `video-agent-magic-${Date.now()}`,
);

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
});
afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
});
afterEach(async () => {
  // Clean inter-test files.
  const entries = await import("node:fs/promises").then((m) =>
    m.readdir(TMP),
  );
  await Promise.all(entries.map((e) => rm(path.join(TMP, e), { force: true })));
});

describe("isMagicDoc", () => {
  test("matches the canonical marker at top of file", () => {
    expect(isMagicDoc("# MAGIC DOC: Acme Co Brand Guidelines\n\n…")).toBe(true);
  });

  test("matches with extra whitespace and case variations", () => {
    expect(isMagicDoc("#Magic Doc: foo\n")).toBe(true);
    expect(isMagicDoc("#  MAGIC  DOC  : bar\n")).toBe(true);
  });

  test("rejects when marker is absent", () => {
    expect(isMagicDoc("# Acme Co Brand Guidelines\n")).toBe(false);
    expect(isMagicDoc("Some random text\n")).toBe(false);
    expect(isMagicDoc("")).toBe(false);
  });

  test("rejects when marker is buried past the top 500 bytes", () => {
    const padded = "x".repeat(600) + "\n# MAGIC DOC: late\n";
    expect(isMagicDoc(padded)).toBe(false);
  });
});

describe("loadMagicDoc", () => {
  test("returns content for a real magic doc", async () => {
    const file = path.join(TMP, "guidelines.md");
    await writeFile(file, "# MAGIC DOC: Acme\n## body\n");
    const r = await loadMagicDoc(file);
    expect(r).toContain("# MAGIC DOC: Acme");
  });

  test("returns null for a non-magic file", async () => {
    const file = path.join(TMP, "plain.md");
    await writeFile(file, "# Acme Co Brand Guidelines\n");
    expect(await loadMagicDoc(file)).toBeNull();
  });

  test("returns null when the file doesn't exist", async () => {
    expect(await loadMagicDoc(path.join(TMP, "nope.md"))).toBeNull();
  });
});

describe("updateMagicDoc", () => {
  test("atomically rewrites the doc when the updater preserves the marker", async () => {
    const file = path.join(TMP, "guide.md");
    await writeFile(file, "# MAGIC DOC: Acme\n## body\n");
    const result = await updateMagicDoc(
      file,
      ["new spokesperson dropped"],
      async (current, observations) => {
        return current + "\n## auto-update\n" + observations.join("\n") + "\n";
      },
    );
    expect(result.bytes).toBeGreaterThan(0);
    const onDisk = await readFile(file, "utf-8");
    expect(onDisk).toContain("# MAGIC DOC: Acme");
    expect(onDisk).toContain("new spokesperson dropped");
  });

  test("throws when target file is not a magic doc", async () => {
    const file = path.join(TMP, "plain.md");
    await writeFile(file, "# Plain Doc\n");
    await expect(
      updateMagicDoc(file, [], async (c) => c),
    ).rejects.toThrow(/not a magic doc/);
  });

  test("throws when updater drops the magic-doc marker", async () => {
    const file = path.join(TMP, "marker.md");
    await writeFile(file, "# MAGIC DOC: Acme\n## body\n");
    await expect(
      updateMagicDoc(file, [], async () => "## stripped marker\n"),
    ).rejects.toThrow(/dropped the # MAGIC DOC: marker/);
  });

  test("throws cleanly when target file doesn't exist", async () => {
    await expect(
      updateMagicDoc(
        path.join(TMP, "nope.md"),
        [],
        async (c) => c,
      ),
    ).rejects.toThrow(/not a magic doc/);
  });
});
