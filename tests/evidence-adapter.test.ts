import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalEvidenceAdapter } from "../src/adapters/evidence/index.js";
import { type ArtifactId, type RunId, type RunManifest } from "../src/contracts/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const runId = "run-00000001" as RunId;

describe("LocalEvidenceAdapter", () => {
  it("keeps manifest revisions immutable and enforces total limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-evidence-"));
    roots.push(root);
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 20, 20);
    expect((await evidence.preflight(runId)).ok).toBe(true);
    const artifact = await evidence.commitArtifact({
      runId,
      type: "test",
      mimeType: "text/plain",
      sensitivity: "normal",
      bytes: new TextEncoder().encode("1234567890"),
    });
    expect(artifact.ok).toBe(true);
    expect(
      (
        await evidence.commitArtifact({
          runId,
          type: "test",
          mimeType: "text/plain",
          sensitivity: "normal",
          bytes: new TextEncoder().encode("abcdefghijk"),
        })
      ).ok,
    ).toBe(false);
    const manifest: RunManifest = {
      schemaVersion: 1,
      revision: 1,
      runId,
      buildVersion: "test",
      eventCount: 0,
      timelineSha256: "a".repeat(64),
      result: { verdict: "inconclusive", evidence: "incomplete", cleanup: "completed" },
      artifacts: [],
    };
    expect((await evidence.commitManifest(manifest)).ok).toBe(true);
    expect((await evidence.commitManifest(manifest)).ok).toBe(false);
  });

  it("rejects symlink artifacts during verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-symlink-"));
    roots.push(root);
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 1000, 10000);
    await evidence.append({
      schemaVersion: 1,
      runId,
      sequence: 1,
      recordedAt: "2026-09-21T00:00:00.000Z",
      elapsedMs: 0,
      type: "RunStarted",
      source: "kernel",
      data: { mode: "interactive" },
    });
    const external = join(root, "outside");
    const { writeFile, mkdir } = await import("node:fs/promises");
    await writeFile(external, "secret");
    const runDir = join(root, "evidence", "runs", runId);
    await mkdir(join(runDir, "artifacts"), { recursive: true });
    await symlink(external, join(runDir, "artifacts", "linked"));
    const timeline = await readFile(join(runDir, "timeline.jsonl"));
    const { createHash } = await import("node:crypto");
    const manifest: RunManifest = {
      schemaVersion: 1,
      revision: 1,
      runId,
      buildVersion: "test",
      eventCount: 1,
      timelineSha256: createHash("sha256").update(timeline).digest("hex"),
      result: { verdict: "inconclusive", evidence: "incomplete", cleanup: "completed" },
      artifacts: [
        {
          artifactId: "artifact-00000001" as ArtifactId,
          type: "test",
          relativePath: "artifacts/linked",
          mimeType: "text/plain",
          size: 6,
          sha256: createHash("sha256").update("secret").digest("hex"),
          sensitivity: "normal",
        },
      ],
    };
    await evidence.commitManifest(manifest);
    expect((await evidence.showRun(runId)).ok).toBe(false);
  });

  it("does not advertise an artifact when a crash occurs before rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-crash-"));
    roots.push(root);
    const evidence = new LocalEvidenceAdapter(
      join(root, "evidence"),
      join(root, "state"),
      1000,
      10000,
      (point) => {
        if (point === "artifact-before-rename") throw new Error("simulated crash");
      },
    );
    const committed = await evidence.commitArtifact({
      runId,
      type: "test",
      mimeType: "text/plain",
      sensitivity: "normal",
      bytes: new TextEncoder().encode("data"),
    });
    expect(committed.ok).toBe(false);
    expect((await evidence.recoverOrphans(runId)).ok).toBe(true);
  });
});
