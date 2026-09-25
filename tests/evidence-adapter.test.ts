import { lstat, mkdtemp, mkdir, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalEvidenceAdapter } from "../src/adapters/evidence/index.js";
import { type ArtifactId, type RunId, type RunManifest } from "../src/contracts/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const runId = "run-00000001" as RunId;

describe("LocalEvidenceAdapter", () => {
  it("retains active Runs while deleting eligible Evidence despite an unrelated corrupt Run", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-retention-"));
    roots.push(root);
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 1000);
    const active = "run-00000002" as RunId;
    for (const id of [runId, active])
      await evidence.append({
        schemaVersion: 1,
        runId: id,
        sequence: 1,
        recordedAt: "2026-01-01T00:00:00.000Z",
        elapsedMs: 0,
        type: "RunStarted",
        source: "kernel",
        data: { mode: "interactive" },
      });
    await evidence.append({
      schemaVersion: 1,
      runId,
      sequence: 2,
      recordedAt: "2026-01-01T00:00:01.000Z",
      elapsedMs: 1,
      type: "RunFinished",
      source: "kernel",
      data: { verdict: "inconclusive", evidence: "incomplete", cleanup: "failed" },
    });
    await mkdir(join(root, "evidence", "runs", "run-00000003"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, "evidence", "runs", "run-00000003", "timeline.jsonl"), "corrupt");
    const result = await evidence.applyRetention(7, Date.parse("2026-09-22T00:00:00.000Z"));
    expect(result).toEqual({ ok: true, value: [runId] });
    expect(await readdir(join(root, "evidence", "runs"))).toContain(active);
    expect(await readFile(join(root, "state", "retention-audit.jsonl"), "utf8")).toContain("completed");
  });
  it("reports the latest failed retention audit per Run", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-retention-audit-"));
    roots.push(root);
    const state = join(root, "state");
    await mkdir(state);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(state, "retention-audit.jsonl"),
      [
        { runId, phase: "failed", recordedAt: "2026-01-01T00:00:00.000Z" },
        { runId: "run-00000002", phase: "failed", recordedAt: "2026-01-01T00:00:00.000Z" },
        { runId: "run-00000002", phase: "completed", deletedAt: "2026-01-01T00:00:01.000Z" },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n",
    );
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), state, 1000);
    expect(await evidence.listRetentionFailures()).toEqual({ ok: true, value: [runId] });
  });
  it("reports retention audit infrastructure failure instead of swallowing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-retention-audit-failure-"));
    roots.push(root);
    const state = join(root, "state");
    await mkdir(state);
    await symlink(join(root, "outside"), join(state, "retention-audit.jsonl"));
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), state, 1000);
    expect(await evidence.applyRetention(7)).toMatchObject({
      ok: false,
      error: { code: "EvidenceIncomplete" },
    });
  });
  it("rejects an artifact directory symlink before writing outside the Run", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-artifact-link-"));
    roots.push(root);
    const outside = join(root, "outside");
    const run = join(root, "evidence", "runs", runId);
    await mkdir(outside);
    await mkdir(run, { recursive: true });
    await symlink(outside, join(run, "artifacts"));
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 1000);
    const result = await evidence.commitArtifact({
      runId,
      type: "test",
      mimeType: "text/plain",
      sensitivity: "normal",
      bytes: new TextEncoder().encode("data"),
    });
    expect(result.ok).toBe(false);
    expect(await readdir(outside)).toEqual([]);
  });
  it("rejects a configured Evidence root that is itself a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-root-link-"));
    roots.push(root);
    const outside = join(root, "outside");
    const linked = join(root, "linked");
    await mkdir(outside);
    await symlink(outside, linked);
    expect(() => new LocalEvidenceAdapter(linked, join(root, "state"), 1000)).toThrow();
  });
  it("lists healthy and corrupt Run IDs while show reports the corrupt Run explicitly", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-list-corrupt-"));
    roots.push(root);
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    await evidence.append({
      schemaVersion: 1,
      runId,
      sequence: 1,
      recordedAt: "2026-01-01T00:00:00.000Z",
      elapsedMs: 0,
      type: "RunStarted",
      source: "kernel",
      data: { mode: "interactive" },
    });
    await mkdir(join(root, "evidence", "runs", "run-00000002"), { recursive: true });
    const { appendFile, writeFile } = await import("node:fs/promises");
    await writeFile(join(root, "evidence", "runs", "run-00000002", "timeline.jsonl"), "broken");
    await appendFile(
      join(root, "state", "runs-index.jsonl"),
      `${JSON.stringify({ schemaVersion: 1, runId: "run-00000002", event: "RunStarted", recordedAt: "2026-01-01T00:00:00.000Z" })}\n`,
    );
    expect(await evidence.listRuns()).toEqual({
      ok: true,
      value: [runId, "run-00000002"],
    });
    expect(await evidence.showRun("run-00000002" as RunId)).toMatchObject({
      ok: false,
      error: { code: "EvidenceCorrupted" },
    });
  });
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
    await evidence.append({
      schemaVersion: 1,
      runId,
      sequence: 2,
      recordedAt: "2026-09-21T00:00:01.000Z",
      elapsedMs: 1,
      type: "RunFinished",
      source: "kernel",
      data: { verdict: "inconclusive", evidence: "incomplete", cleanup: "completed" },
    });
    const timeline = await readFile(join(runDir, "timeline.jsonl"));
    const { createHash } = await import("node:crypto");
    const manifest: RunManifest = {
      schemaVersion: 1,
      revision: 1,
      runId,
      buildVersion: "test",
      eventCount: 2,
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
  it.each([
    "artifact-before-fsync",
    "journal-before-fsync",
    "journal-before-rename",
    "manifest-before-fsync",
    "manifest-before-rename",
  ])("fails closed at the %s durability boundary", async (faultPoint) => {
    const root = await mkdtemp(join(tmpdir(), "mcu-durability-"));
    roots.push(root);
    const evidence = new LocalEvidenceAdapter(
      join(root, "evidence"),
      join(root, "state"),
      10_000,
      100_000,
      (point) => {
        if (point === faultPoint) throw new Error("simulated crash");
      },
    );
    if (faultPoint.startsWith("artifact")) {
      expect(
        (
          await evidence.commitArtifact({
            runId,
            type: "test",
            mimeType: "text/plain",
            sensitivity: "normal",
            bytes: new TextEncoder().encode("data"),
          })
        ).ok,
      ).toBe(false);
      return;
    }
    const appended = await evidence.append({
      schemaVersion: 1,
      runId,
      sequence: 1,
      recordedAt: "2026-01-01T00:00:00.000Z",
      elapsedMs: 0,
      type: "RunStarted",
      source: "kernel",
      data: { mode: "interactive" },
    });
    if (faultPoint.startsWith("journal-")) {
      expect(appended.ok).toBe(false);
      return;
    }
    expect(appended.ok).toBe(true);
    const timeline = await readFile(join(root, "evidence", "runs", runId, "timeline.jsonl"));
    const { createHash } = await import("node:crypto");
    expect(
      (
        await evidence.commitManifest({
          schemaVersion: 1,
          revision: 1,
          runId,
          buildVersion: "test",
          eventCount: 1,
          timelineSha256: createHash("sha256").update(timeline).digest("hex"),
          result: { verdict: "inconclusive", evidence: "incomplete", cleanup: "completed" },
          artifacts: [],
        })
      ).ok,
    ).toBe(false);
  });
  it("automatically resumes projections and index after an event rename succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-journal-reconcile-"));
    roots.push(root);
    const evidence = new LocalEvidenceAdapter(
      join(root, "evidence"),
      join(root, "state"),
      10_000,
      100_000,
      (point) => {
        if (point === "journal-after-rename") throw new Error("simulated crash");
      },
    );
    const event = {
      schemaVersion: 1,
      runId,
      sequence: 1,
      recordedAt: "2026-01-01T00:00:00.000Z",
      elapsedMs: 0,
      type: "RunStarted",
      source: "kernel",
      data: { mode: "interactive" },
    } as const;
    expect((await evidence.append(event)).ok).toBe(true);
    expect(await evidence.readTimeline(runId)).toMatchObject({ ok: true, value: [{ sequence: 1 }] });
    const index = await readFile(join(root, "state", "runs-index.jsonl"), "utf8");
    expect(index.trim().split("\n")).toHaveLength(1);
  });
  it("creates the declared per-Run temporary directory during preflight", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-temp-layout-"));
    roots.push(root);
    const evidence = new LocalEvidenceAdapter(
      join(root, "evidence"),
      join(root, "state"),
      1000,
      10_000,
      undefined,
      join(root, "temp"),
    );
    expect((await evidence.preflight(runId)).ok).toBe(true);
    expect((await lstat(join(root, "temp", runId))).isDirectory()).toBe(true);
  });
  it("rebuilds deterministic projections and index from the authoritative timeline", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-projection-replay-"));
    roots.push(root);
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    const events = [
      { type: "RunStarted", data: { mode: "interactive" } },
      { type: "StepProjected", data: { stepId: "one", status: "completed" } },
      { type: "RunRecoveryStarted", data: { resourceId: runId } },
    ] as const;
    for (const [index, event] of events.entries())
      expect(
        (
          await evidence.append({
            schemaVersion: 1,
            runId,
            sequence: index + 1,
            recordedAt: `2026-01-01T00:00:0${String(index)}.000Z`,
            elapsedMs: index,
            source: "kernel",
            ...event,
          })
        ).ok,
      ).toBe(true);
    await rm(join(root, "state", "runs-index.jsonl"));
    await rm(join(root, "state", "recovery"), { recursive: true });
    await rm(join(root, "evidence", "runs", runId, "steps"), { recursive: true });
    expect((await evidence.reconcileProjections()).ok).toBe(true);
    expect(await readFile(join(root, "state", "runs-index.jsonl"), "utf8")).toContain(runId);
    expect(
      JSON.parse(await readFile(join(root, "evidence", "runs", runId, "steps", "one.json"), "utf8")),
    ).toMatchObject({ status: "completed" });
    expect(
      JSON.parse(await readFile(join(root, "state", "recovery", `${runId}.json`), "utf8")),
    ).toMatchObject({ status: "started" });
  });
  it("records a damaged Run terminal state without rewriting corrupt timeline bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-damaged-run-"));
    roots.push(root);
    const run = join(root, "evidence", "runs", runId);
    await mkdir(run, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(run, "timeline.jsonl"), "unknown-schema-bytes\n");
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    expect((await evidence.recordDamagedRun(runId, "test", "completed")).ok).toBe(true);
    expect(await readFile(join(run, "timeline.jsonl"), "utf8")).toBe("unknown-schema-bytes\n");
    expect(
      JSON.parse(await readFile(join(root, "state", "recovery", `${runId}.json`), "utf8")),
    ).toMatchObject({
      runId,
      status: "failed",
      unknownDispatch: true,
      timelineBytes: 21,
      result: { verdict: "inconclusive", evidence: "incomplete", cleanup: "completed" },
    });
  });
  it("projects durable Step facts into the declared steps layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-step-projection-"));
    roots.push(root);
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    await evidence.append({
      schemaVersion: 1,
      runId,
      sequence: 1,
      recordedAt: "2026-01-01T00:00:00.000Z",
      elapsedMs: 0,
      type: "RunStarted",
      source: "kernel",
      data: { mode: "interactive" },
    });
    await evidence.append({
      schemaVersion: 1,
      runId,
      sequence: 2,
      recordedAt: "2026-01-01T00:00:01.000Z",
      elapsedMs: 1,
      type: "StepProjected",
      source: "kernel",
      data: { stepId: "click-one", status: "completed" },
    });
    expect(
      JSON.parse(await readFile(join(root, "evidence", "runs", runId, "steps", "click-one.json"), "utf8")),
    ).toMatchObject({ runId, stepId: "click-one", status: "completed" });
  });
  it("projects environment, diagnostics, and recovery records into the declared layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-layout-projection-"));
    roots.push(root);
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    await evidence.append({
      schemaVersion: 1,
      runId,
      sequence: 1,
      recordedAt: "2026-01-01T00:00:00.000Z",
      elapsedMs: 0,
      type: "RunRecoveryStarted",
      source: "kernel",
      data: { resourceId: runId },
    });
    const environment = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        buildIdentity: "build-1",
        imageDigest: `sha256:${"a".repeat(64)}`,
        compatibility: {
          tart: "2.35",
          appiumMajor: 3,
          appium: "3.7.0",
          mac2: "4.3.5",
          wdaSha256: "094e95c782c034d5755a4056e55ae6e98284e9f2339f15b210a1309c4f46b733",
          guestMacOS: "26.6.2",
          xcode: "26.0",
          fixtureBuild: "1",
        },
        bundleId: "com.example.App",
        actual: {
          guestMacOS: "26.6.2",
          xcode: "26.0",
          appium: "3.7.0",
          mac2: "4.3.5",
          wdaSha256: "094e95c782c034d5755a4056e55ae6e98284e9f2339f15b210a1309c4f46b733",
          buildIdentity: "build-1",
          fixtureBuild: "1",
          bundleId: "com.example.App",
          windowServerReady: true,
          automationPermissionReady: true,
        },
      }),
    );
    expect(
      (
        await evidence.commitArtifact({
          runId,
          type: "environment",
          mimeType: "application/json",
          sensitivity: "normal",
          bytes: environment,
        })
      ).ok,
    ).toBe(true);
    const diagnostics = await evidence.commitArtifact({
      runId,
      type: "guest-diagnostics",
      mimeType: "application/json",
      sensitivity: "potentiallySensitive",
      bytes: new TextEncoder().encode("{}"),
    });
    expect(diagnostics.ok && diagnostics.value.relativePath.startsWith("diagnostics/")).toBe(true);
    expect(
      JSON.parse(await readFile(join(root, "evidence", "runs", runId, "environment.json"), "utf8")),
    ).toEqual(JSON.parse(new TextDecoder().decode(environment)));
    expect(
      JSON.parse(await readFile(join(root, "state", "recovery", `${runId}.json`), "utf8")),
    ).toMatchObject({ runId, status: "started" });
  });
});
