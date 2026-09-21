import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ArtifactDescriptorSchema,
  EvidenceEventSchema,
  ManagedResourceRecordSchema,
  RunIndexEntrySchema,
  RunManifestSchema,
  err,
  ok,
  type ArtifactDescriptor,
  type EvidenceEvent,
  type EvidencePort,
  type ManagedResourceRecord,
  type OperationResult,
  type RunId,
  type RunManifest,
  type RunResult,
} from "../../contracts/index.js";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const jsonLine = (value: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(value)}\n`);

export class LocalEvidenceAdapter implements EvidencePort {
  readonly #root: string;
  readonly #stateRoot: string;
  readonly #maxArtifactBytes: number;
  readonly #maxRunBytes: number;
  readonly #fault: (point: string) => void;

  constructor(
    root: string,
    stateRoot: string,
    maxArtifactBytes: number,
    maxRunBytes = maxArtifactBytes * 10,
    fault: (point: string) => void = () => undefined,
  ) {
    this.#root = root;
    this.#stateRoot = stateRoot;
    this.#maxArtifactBytes = maxArtifactBytes;
    this.#maxRunBytes = maxRunBytes;
    this.#fault = fault;
  }

  async preflight(runId: RunId): Promise<OperationResult<void>> {
    try {
      const directory = this.#runDir(runId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, `.preflight-${crypto.randomUUID()}`);
      const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      try {
        await handle.write("ok");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rm(path);
      return ok(undefined);
    } catch {
      return err({
        code: "EvidenceIncomplete",
        phase: "evidence",
        message: "Evidence preflight failed.",
        retryDisposition: "notApplicable",
      });
    }
  }

  async recoverOrphans(runId: RunId): Promise<OperationResult<number>> {
    try {
      const directory = this.#runDir(runId);
      const entries = await readdir(directory).catch(() => []);
      let removed = 0;
      for (const name of entries) {
        if (!name.endsWith(".tmp") && !name.startsWith(".artifact-")) continue;
        await rm(join(directory, name), { force: true });
        removed += 1;
      }
      return ok(removed);
    } catch {
      return err({
        code: "EvidenceCorrupted",
        phase: "evidence",
        message: "Orphan Evidence could not be recovered.",
        retryDisposition: "notApplicable",
      });
    }
  }

  async append(input: EvidenceEvent): Promise<OperationResult<void>> {
    try {
      const event = EvidenceEventSchema.parse(input);
      const runDir = this.#runDir(event.runId);
      await mkdir(runDir, { recursive: true, mode: 0o700 });
      const timeline = join(runDir, "timeline.jsonl");
      const existing = await this.readTimeline(event.runId);
      if (!existing.ok) return existing;
      const expected = existing.value.length + 1;
      if (event.sequence !== expected)
        return err({
          code: "EvidenceCorrupted",
          phase: "evidence",
          message: `Expected event sequence ${String(expected)}.`,
          retryDisposition: "notApplicable",
        });
      const handle = await open(
        timeline,
        fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY,
        0o600,
      );
      try {
        await handle.write(jsonLine(event));
        this.#fault("journal-before-fsync");
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (event.type === "RunStarted" || event.type === "RunFinished") {
        await mkdir(this.#stateRoot, { recursive: true, mode: 0o700 });
        const index = await open(
          join(this.#stateRoot, "runs-index.jsonl"),
          fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY,
          0o600,
        );
        try {
          await index.write(
            `${JSON.stringify({ schemaVersion: 1, runId: event.runId, event: event.type, recordedAt: event.recordedAt })}\n`,
          );
          await index.sync();
        } finally {
          await index.close();
        }
      }
      return ok(undefined);
    } catch {
      return err({
        code: "EvidenceIncomplete",
        phase: "evidence",
        message: "Evidence event could not be committed.",
        retryDisposition: "notApplicable",
      });
    }
  }

  async commitArtifact(request: {
    runId: RunId;
    type: string;
    mimeType: string;
    sensitivity: "normal" | "potentiallySensitive";
    bytes: Uint8Array;
  }): Promise<OperationResult<ArtifactDescriptor>> {
    try {
      if (request.bytes.byteLength > this.#maxArtifactBytes) throw new Error("artifact limit");
      if ((await this.#runSize(request.runId)) + request.bytes.byteLength > this.#maxRunBytes)
        throw new Error("run limit");
      const hash = sha256(request.bytes);
      const artifactId = `artifact-${hash.slice(0, 24)}` as ArtifactDescriptor["artifactId"];
      const relativePath = `artifacts/${hash}`;
      const target = join(this.#runDir(request.runId), relativePath);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const existing = await stat(target).catch(() => undefined);
      if (existing) {
        if (existing.size !== request.bytes.byteLength || sha256(await readFile(target)) !== hash)
          throw new Error("hash mismatch");
      } else {
        const temp = join(this.#runDir(request.runId), `.artifact-${crypto.randomUUID()}.tmp`);
        const handle = await open(
          temp,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
          0o600,
        );
        try {
          await handle.write(request.bytes);
          this.#fault("artifact-before-fsync");
          await handle.sync();
        } finally {
          await handle.close();
        }
        this.#fault("artifact-before-rename");
        await rename(temp, target);
        const dir = await open(dirname(target), fsConstants.O_RDONLY);
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      }
      return ok(
        ArtifactDescriptorSchema.parse({
          artifactId,
          type: request.type,
          relativePath,
          mimeType: request.mimeType,
          size: request.bytes.byteLength,
          sha256: hash,
          sensitivity: request.sensitivity,
        }),
      );
    } catch {
      return err({
        code: "EvidenceIncomplete",
        phase: "evidence",
        message: "Artifact could not be committed.",
        retryDisposition: "notApplicable",
      });
    }
  }

  async commitManifest(
    input: RunManifest,
  ): Promise<OperationResult<{ relativePath: string; sha256: string }>> {
    try {
      const manifest = RunManifestSchema.parse(input);
      const bytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
      const relativePath = `manifest.v${String(manifest.revision)}.json`;
      const target = join(this.#runDir(manifest.runId), relativePath);
      if (await stat(target).catch(() => undefined)) throw new Error("manifest revision exists");
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const temp = `${target}.${crypto.randomUUID()}.tmp`;
      const handle = await open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      try {
        await handle.write(bytes);
        this.#fault("manifest-before-fsync");
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.#fault("manifest-before-rename");
      await rename(temp, target);
      const dir = await open(dirname(target), fsConstants.O_RDONLY);
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
      return ok({ relativePath, sha256: sha256(bytes) });
    } catch {
      return err({
        code: "EvidenceIncomplete",
        phase: "evidence",
        message: "Manifest could not be committed.",
        retryDisposition: "notApplicable",
      });
    }
  }

  async commitRecoveryManifest(
    runId: RunId,
    buildVersion: string,
    result: RunResult,
    artifacts: readonly ArtifactDescriptor[] = [],
  ): Promise<OperationResult<{ relativePath: string; sha256: string }>> {
    try {
      const files = await readdir(this.#runDir(runId));
      const revisions = files
        .flatMap((name) => {
          const match = /^manifest\.v(\d+)\.json$/.exec(name);
          return match?.[1] ? [{ name, revision: Number(match[1]) }] : [];
        })
        .sort((a, b) => b.revision - a.revision);
      const previous = revisions[0];
      const previousBytes = previous ? await readFile(join(this.#runDir(runId), previous.name)) : undefined;
      const previousManifest = previousBytes
        ? RunManifestSchema.parse(JSON.parse(previousBytes.toString("utf8")) as unknown)
        : undefined;
      const timeline = await readFile(join(this.#runDir(runId), "timeline.jsonl"));
      return await this.commitManifest({
        schemaVersion: 1,
        revision: (previous?.revision ?? 0) + 1,
        runId,
        buildVersion,
        eventCount: timeline.toString("utf8").trimEnd().split("\n").filter(Boolean).length,
        timelineSha256: sha256(timeline),
        result,
        artifacts: [...(previousManifest?.artifacts ?? []), ...artifacts],
        ...(previousBytes ? { previousRevisionSha256: sha256(previousBytes) } : {}),
      });
    } catch {
      return err({
        code: "EvidenceIncomplete",
        phase: "evidence",
        message: "Recovery Manifest could not be committed.",
        retryDisposition: "notApplicable",
      });
    }
  }

  async readTimeline(runId: RunId): Promise<OperationResult<readonly EvidenceEvent[]>> {
    try {
      const raw = await readFile(join(this.#runDir(runId), "timeline.jsonl"), "utf8").catch(
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
          throw error;
        },
      );
      const events =
        raw.trim() === ""
          ? []
          : raw
              .trimEnd()
              .split("\n")
              .map((line) => EvidenceEventSchema.parse(JSON.parse(line) as unknown));
      events.forEach((event, index) => {
        if (event.sequence !== index + 1) throw new Error("sequence");
      });
      return ok(events);
    } catch {
      return err({
        code: "EvidenceCorrupted",
        phase: "evidence",
        message: "Timeline could not be verified.",
        retryDisposition: "notApplicable",
      });
    }
  }

  async listRuns(): Promise<OperationResult<readonly RunId[]>> {
    try {
      const raw = await readFile(join(this.#stateRoot, "runs-index.jsonl"), "utf8").catch(
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
          throw error;
        },
      );
      const ids = new Set<RunId>();
      for (const line of raw.split("\n").filter(Boolean)) {
        const value = RunIndexEntrySchema.parse(JSON.parse(line) as unknown);
        ids.add(value.runId);
      }
      return ok([...ids].sort());
    } catch {
      return err({
        code: "EvidenceCorrupted",
        phase: "evidence",
        message: "Run index could not be read.",
        retryDisposition: "notApplicable",
      });
    }
  }

  async showRun(runId: RunId): Promise<OperationResult<RunManifest>> {
    try {
      const files = await readdir(this.#runDir(runId));
      const revisions = files
        .flatMap((name) => {
          const match = /^manifest\.v(\d+)\.json$/.exec(name);
          return match?.[1] ? [{ name, revision: Number(match[1]) }] : [];
        })
        .sort((a, b) => b.revision - a.revision);
      const latest = revisions[0];
      if (!latest) throw new Error("manifest missing");
      for (let index = 0; index < revisions.length - 1; index += 1) {
        const current = revisions[index];
        const previous = revisions[index + 1];
        if (!current || !previous || current.revision !== previous.revision + 1)
          throw new Error("manifest revision gap");
        const currentManifest = RunManifestSchema.parse(
          JSON.parse(await readFile(join(this.#runDir(runId), current.name), "utf8")) as unknown,
        );
        const previousBytes = await readFile(join(this.#runDir(runId), previous.name));
        if (currentManifest.previousRevisionSha256 !== sha256(previousBytes))
          throw new Error("manifest revision chain");
      }
      const manifest = RunManifestSchema.parse(
        JSON.parse(await readFile(join(this.#runDir(runId), latest.name), "utf8")) as unknown,
      );
      const timeline = await readFile(join(this.#runDir(runId), "timeline.jsonl"));
      if (sha256(timeline) !== manifest.timelineSha256) throw new Error("timeline hash");
      const events = timeline
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .filter(Boolean)
        .map((line) => EvidenceEventSchema.parse(JSON.parse(line) as unknown));
      if (events.length !== manifest.eventCount) throw new Error("event count");
      const finished = [...events].reverse().find((event) => event.type === "RunFinished");
      if (!finished || JSON.stringify(finished.data) !== JSON.stringify(manifest.result))
        throw new Error("manifest result mismatch");
      const artifactIds = new Set(manifest.artifacts.map((artifact) => artifact.artifactId));
      if (manifest.configArtifact && !artifactIds.has(manifest.configArtifact.artifactId))
        throw new Error("config artifact missing");
      if (manifest.environmentArtifact && !artifactIds.has(manifest.environmentArtifact.artifactId))
        throw new Error("environment artifact missing");
      for (const artifact of manifest.artifacts) {
        const path = this.#safeRunPath(runId, artifact.relativePath);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe artifact");
        const bytes = await readFile(path);
        if (bytes.byteLength !== artifact.size || sha256(bytes) !== artifact.sha256)
          throw new Error("artifact hash");
      }
      return ok(manifest);
    } catch {
      return err({
        code: "EvidenceCorrupted",
        phase: "evidence",
        message: "Run Evidence could not be verified.",
        retryDisposition: "notApplicable",
      });
    }
  }

  async exportRun(runId: RunId, destination: string): Promise<OperationResult<{ destination: string }>> {
    const verified = await this.showRun(runId);
    if (!verified.ok) return verified;
    try {
      await mkdir(destination, { recursive: true, mode: 0o700 });
      await cp(this.#runDir(runId), destination, { recursive: true, errorOnExist: true, force: false });
      return ok({ destination });
    } catch {
      return err({
        code: "ProviderFailure",
        phase: "evidence",
        message: "Verified Evidence could not be exported.",
        retryDisposition: "safe",
      });
    }
  }

  async readManagedResource(): Promise<OperationResult<ManagedResourceRecord | null>> {
    try {
      const raw = await readFile(join(this.#stateRoot, "managed-resource.json"), "utf8").catch(
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        },
      );
      return ok(raw === null ? null : ManagedResourceRecordSchema.parse(JSON.parse(raw) as unknown));
    } catch {
      return err({
        code: "RecoveryRequired",
        phase: "vm",
        message: "Managed resource state is invalid.",
        retryDisposition: "notApplicable",
      });
    }
  }

  async writeManagedResource(input: ManagedResourceRecord): Promise<OperationResult<void>> {
    try {
      const record = ManagedResourceRecordSchema.parse(input);
      await mkdir(this.#stateRoot, { recursive: true, mode: 0o700 });
      const target = join(this.#stateRoot, "managed-resource.json");
      const temp = `${target}.${crypto.randomUUID()}.tmp`;
      const handle = await open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      try {
        await handle.write(`${JSON.stringify(record)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, target);
      const dir = await open(this.#stateRoot, fsConstants.O_RDONLY);
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
      return ok(undefined);
    } catch {
      return err({
        code: "EvidenceIncomplete",
        phase: "evidence",
        message: "Managed resource state could not be committed.",
        retryDisposition: "notApplicable",
      });
    }
  }

  async clearManagedResource(): Promise<OperationResult<void>> {
    try {
      await rm(join(this.#stateRoot, "managed-resource.json"), { force: true });
      const dir = await open(this.#stateRoot, fsConstants.O_RDONLY).catch(() => undefined);
      if (dir) {
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      }
      return ok(undefined);
    } catch {
      return err({
        code: "RecoveryRequired",
        phase: "cleanup",
        message: "Managed resource state could not be cleared.",
        retryDisposition: "notApplicable",
      });
    }
  }

  async applyRetention(
    maxAgeDays: number | null,
    now = Date.now(),
  ): Promise<OperationResult<readonly RunId[]>> {
    if (maxAgeDays === null) return ok([]);
    const runs = await this.listRuns();
    if (!runs.ok) return runs;
    const deleted: RunId[] = [];
    for (const runId of runs.value) {
      const manifest = await this.showRun(runId);
      if (!manifest.ok) continue;
      const timeline = await this.readTimeline(runId);
      if (!timeline.ok) continue;
      const finished = [...timeline.value].reverse().find((event) => event.type === "RunFinished");
      if (!finished || now - Date.parse(finished.recordedAt) < maxAgeDays * 86_400_000) continue;
      try {
        await rm(this.#runDir(runId), { recursive: true, force: true });
        deleted.push(runId);
        await mkdir(this.#stateRoot, { recursive: true, mode: 0o700 });
        const audit = await open(
          join(this.#stateRoot, "retention-audit.jsonl"),
          fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY,
          0o600,
        );
        try {
          await audit.write(`${JSON.stringify({ runId, deletedAt: new Date(now).toISOString() })}\n`);
          await audit.sync();
        } finally {
          await audit.close();
        }
      } catch {
        /* continue with other Runs */
      }
    }
    return ok(deleted);
  }

  #runDir(runId: RunId): string {
    return join(this.#root, "runs", runId);
  }

  #safeRunPath(runId: RunId, relativePath: string): string {
    if (relativePath.startsWith("/") || relativePath.split("/").includes(".."))
      throw new Error("unsafe path");
    const root = this.#runDir(runId);
    const resolved = join(root, relativePath);
    if (!resolved.startsWith(`${root}/`)) throw new Error("path escape");
    return resolved;
  }

  async #runSize(runId: RunId): Promise<number> {
    const walk = async (directory: string): Promise<number> => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      let total = 0;
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error("symlink");
        total += entry.isDirectory() ? await walk(path) : entry.isFile() ? (await stat(path)).size : 0;
      }
      return total;
    };
    return walk(this.#runDir(runId));
  }
}
