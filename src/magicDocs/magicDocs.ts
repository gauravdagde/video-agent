import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

// Plan §F — MagicDocs are markdown files marked with `# MAGIC DOC: <title>`
// at the top. When read by an agent, a forked subagent later updates the
// doc with new learnings — read-triggered, post-sampling, only between
// agent runs (never mid-run, so it can't corrupt an in-flight EditPlan).
//
// Phase-1 scope: primitives. Auto-triggering of updates lands in T2.3
// (extractCreativeInsights post-delivery hook), where the observations
// come from delivered batches + initial metrics. Until then this module
// is library-ready but not invoked anywhere automatically.
//
// Brand guidelines.md is the canonical magic-doc consumer.

const MARKER_REGEX = /^#\s*MAGIC\s*DOC\s*:/im;

export function isMagicDoc(content: string): boolean {
  // Marker check is on the first 500 bytes — magic-doc marker must be
  // near the top, not buried in arbitrary content.
  return MARKER_REGEX.test(content.slice(0, 500));
}

export async function loadMagicDoc(filePath: string): Promise<string | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    return isMagicDoc(content) ? content : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export type MagicDocUpdater = (
  current: string,
  observations: readonly string[],
) => Promise<string>;

// Atomic in-place rewrite. The updater is typically a forked-subagent
// call (via forkVideoSubagent) that sees:
//   - current doc content (must preserve the magic-doc marker)
//   - observations from the just-completed agent run
// and produces a new version. We verify the marker survives in the
// output — refusing to write a non-magic-doc back to a magic-doc file.
export async function updateMagicDoc(
  filePath: string,
  observations: readonly string[],
  updater: MagicDocUpdater,
): Promise<{ readonly path: string; readonly bytes: number }> {
  const current = await loadMagicDoc(filePath);
  if (current === null) {
    throw new Error(
      `updateMagicDoc: ${filePath} is not a magic doc (missing # MAGIC DOC: marker)`,
    );
  }

  const next = await updater(current, observations);
  if (!isMagicDoc(next)) {
    throw new Error(
      `updateMagicDoc: updater dropped the # MAGIC DOC: marker — refusing to write`,
    );
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, next, "utf-8");
  await rename(tmpPath, filePath);

  return { path: filePath, bytes: Buffer.byteLength(next, "utf-8") };
}
