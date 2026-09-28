import { createHash } from "node:crypto";
import { z } from "zod";
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, relative, sep } from "node:path";
import {
  ArtifactDescriptorSchema,
  ArtifactRefSchema,
  ConfigSnapshotSchema,
  EnvironmentSnapshotSchema,
  ProviderLifecycleDiagnosticSchema,
  EvidenceEventSchema,
  parseEvidenceEvent,
  parseCurrentEvidenceEvent,
  ManagedResourceRecordSchema,
  RunIndexEntrySchema,
  RunManifestSchema,
  RunIdSchema,
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
  ArtifactCommitRequestSchema,
  DamagedRunRecoverySchema,
} from "../../contracts/index.js";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const jsonLine = (value: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
const StoredArtifactSchema = z
  .object({ schemaVersion: z.literal(1), descriptor: ArtifactDescriptorSchema })
  .strict();
const normalizeLegacyEvent = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value;
  const event = value as Record<string, unknown>;
  if (typeof event.data !== "object" || event.data === null) return value;
  const data = event.data as Record<string, unknown>;
  if (event.type === "ActionPlanned" && typeof data.operationId === "string" && !("actionId" in data))
    return { ...event, data: { ...data, actionId: `action-legacy-${String(event.sequence)}` } };
  if (event.type === "RunRecoveryStarted" && typeof data.cloneName === "string") {
    const { cloneName, ...rest } = data;
    return { ...event, data: { ...rest, resourceId: cloneName } };
  }
  return value;
};
const LegacyManagedResourceRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    cloneName: z.string().min(1).max(128),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    phase: z.enum(["clonePlanned", "cloneCreated", "started", "cleanupStarted", "cleanupCompleted"]),
  })
  .strict()
  .transform(({ cloneName, ...record }) => ({ ...record, resourceId: cloneName }));

export class LocalEvidenceAdapter implements EvidencePort {
  readonly #root: string;
  readonly #stateRoot: string;
  readonly #maxArtifactBytes: number;
  readonly #maxRunBytes: number;
  readonly #fault: (point: string) => void;
  readonly #tempRoot?: string;
  readonly #appendResumeAttempts = new Set<string>();

  constructor(
    root: string,
    stateRoot: string,
    maxArtifactBytes: number,
    maxRunBytes = maxArtifactBytes * 10,
    fault: (point: string) => void = () => undefined,
    tempRoot?: string,
  ) {
    this.#root = this.#canonicalRoot(root);
    this.#stateRoot = this.#canonicalRoot(stateRoot);
    this.#maxArtifactBytes = maxArtifactBytes;
    this.#maxRunBytes = maxRunBytes;
    this.#fault = fault;
    if (tempRoot !== undefined) this.#tempRoot = this.#canonicalRoot(tempRoot);
  }

  async reconcileProjections(signal?: AbortSignal): Promise<OperationResult<void>> {
    try {
      if (signal?.aborted) throw signal.reason;
      const entries = await readdir(join(this.#root, "runs"), { withFileTypes: true }).catch(
        (error: unknown) => {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
            return [];
          throw error;
        },
      );
      for (const entry of entries) {
        if (signal?.aborted) throw signal.reason;
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("unsafe Run entry");
        const runId = RunIdSchema.parse(entry.name);
        const timeline = await this.readTimeline(runId, signal);
        if (!timeline.ok) continue;
        for (const event of timeline.value) {
          if (event.type === "StepProjected") await this.#projectStep(event, signal);
          if (event.type === "RunRecoveryStarted" || event.type === "RunRecoveryFinished")
            await this.#projectRecovery(event, signal);
          if (event.type === "RunStarted" || event.type === "RunFinished")
            await this.#projectIndex(event, signal);
        }
      }
      return ok(undefined);
    } catch {
      return err({
        code: "RecoveryRequired",
        phase: "evidence",
        message: "Evidence projections could not be reconciled.",
        retryDisposition: "notApplicable",
      });
    }
  }

  async recordDamagedRun(
    runId: RunId,
    buildVersion: string,
    cleanup: "completed" | "failed",
    signal?: AbortSignal,
  ): Promise<OperationResult<void>> {
    try {
      if (signal?.aborted) throw signal.reason;
      const timeline = await readFile(this.#safeRunPath(runId, "timeline.jsonl"));
      const record = DamagedRunRecoverySchema.parse({
        schemaVersion: 1,
        runId,
        status: "failed",
        recordedAt: new Date().toISOString(),
        buildVersion,
        timelineSha256: sha256(timeline),
        timelineBytes: timeline.byteLength,
        unknownDispatch: true,
        result: { verdict: "inconclusive", evidence: "incomplete", cleanup },
      });
      const recovery = join(this.#stateRoot, "recovery");
      this.#rejectSymlinks(this.#stateRoot, recovery);
      await mkdir(recovery, { recursive: true, mode: 0o700 });
      await this.#replaceProjection(join(recovery, runId + ".json"), jsonLine(record), recovery, signal);
      return ok(undefined);
    } catch {
      return err({
        code: "RecoveryRequired",
        phase: "evidence",
        message: "Damaged Run recovery state could not be recorded.",
        retryDisposition: "notApplicable",
      });
    }
  }

  async preflight(runId: RunId, signal?: AbortSignal): Promise<OperationResult<void>> {
    try {
      if (signal?.aborted) throw signal.reason;
      const directory = this.#runDir(runId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (this.#tempRoot) {
        this.#rejectSymlinks(this.#tempRoot, this.#tempRoot);
        mkdirSync(join(this.#tempRoot, runId), { recursive: true, mode: 0o700 });
      }
      const path = join(directory, `.preflight-${crypto.randomUUID()}`);
      if (signal?.aborted) throw signal.reason;
      const descriptor = openSync(
        path,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      try {
        writeFileSync(descriptor, "ok");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      unlinkSync(path);
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

  async recoverOrphans(runId: RunId, signal?: AbortSignal): Promise<OperationResult<number>> {
    try {
      if (signal?.aborted) throw signal.reason;
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

  async append(input: EvidenceEvent, signal?: AbortSignal): Promise<OperationResult<void>> {
    let event: EvidenceEvent | undefined;
    try {
      if (signal?.aborted) throw signal.reason;
      event = parseCurrentEvidenceEvent(input);
      const runDir = this.#runDir(event.runId);
      await mkdir(runDir, { recursive: true, mode: 0o700 });
      const timeline = join(runDir, "timeline.jsonl");
      const existing = await this.readTimeline(event.runId);
      if (!existing.ok) return existing;
      const last = existing.value.at(-1);
      const resumesDurableEvent =
        event.sequence === existing.value.length &&
        last !== undefined &&
        JSON.stringify(last) === JSON.stringify(event);
      const expected = existing.value.length + 1;
      if (!resumesDurableEvent && event.sequence !== expected)
        return err({
          code: "EvidenceCorrupted",
          phase: "evidence",
          message: `Expected event sequence ${String(expected)}.`,
          retryDisposition: "notApplicable",
        });
      if (!resumesDurableEvent) {
        const existingBytes = await readFile(timeline).catch((error: unknown) => {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
            return Buffer.alloc(0);
          throw error;
        });
        const temp = join(runDir, `.timeline-${crypto.randomUUID()}.tmp`);
        const handle = await open(
          temp,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
          0o600,
        );
        try {
          await handle.write(Buffer.concat([existingBytes, jsonLine(event)]));
          if (signal?.aborted) throw signal.reason;
          this.#fault("journal-before-fsync");
          if (signal?.aborted) throw signal.reason;
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (signal?.aborted) throw signal.reason;
        this.#fault("journal-before-rename");
        if (signal?.aborted) throw signal.reason;
        renameSync(temp, timeline);
        this.#fault("journal-after-rename");
        const journalDirectory = await open(runDir, fsConstants.O_RDONLY);
        try {
          await journalDirectory.sync();
        } finally {
          await journalDirectory.close();
        }
      }
      if (event.type === "StepProjected") await this.#projectStep(event, signal);
      if (event.type === "RunRecoveryStarted" || event.type === "RunRecoveryFinished") {
        await this.#projectRecovery(event, signal);
      }
      if (event.type === "RunStarted" || event.type === "RunFinished") {
        await this.#projectIndex(event, signal);
      }
      return ok(undefined);
    } catch {
      if (event) {
        const key = `${event.runId}:${String(event.sequence)}`;
        const timeline = await this.readTimeline(event.runId, signal);
        const durable = timeline.ok ? timeline.value.at(-1) : undefined;
        if (
          durable &&
          JSON.stringify(durable) === JSON.stringify(event) &&
          !this.#appendResumeAttempts.has(key)
        ) {
          this.#appendResumeAttempts.add(key);
          try {
            return await this.append(event, signal);
          } finally {
            this.#appendResumeAttempts.delete(key);
          }
        }
      }
      return err({
        code: "EvidenceIncomplete",
        phase: "evidence",
        message: "Evidence event could not be committed.",
        retryDisposition: "notApplicable",
      });
    }
  }

  async commitArtifact(
    request: {
      runId: RunId;
      type: string;
      mimeType: string;
      sensitivity: "normal" | "potentiallySensitive";
      bytes: Uint8Array;
    },
    signal?: AbortSignal,
  ): Promise<OperationResult<ArtifactDescriptor>> {
    try {
      request = ArtifactCommitRequestSchema.parse(request);
      if (signal?.aborted) throw signal.reason;
      if (request.bytes.byteLength > this.#maxArtifactBytes) throw new Error("artifact limit");
      this.#validateSnapshot(request.type, request.bytes);
      if ((await this.#runSize(request.runId)) + request.bytes.byteLength > this.#maxRunBytes)
        throw new Error("run limit");
      const hash = sha256(request.bytes);
      const artifactId = `artifact-${hash.slice(0, 24)}` as ArtifactDescriptor["artifactId"];
      const relativePath = request.type === "guest-diagnostics" ? `diagnostics/${hash}` : `artifacts/${hash}`;
      const target = this.#safeRunPath(request.runId, relativePath);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const existing = await lstat(target).catch(() => undefined);
      if (existing) {
        if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("artifact file type");
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
          if (signal?.aborted) throw signal.reason;
          this.#fault("artifact-before-fsync");
          if (signal?.aborted) throw signal.reason;
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (signal?.aborted) throw signal.reason;
        this.#fault("artifact-before-rename");
        if (signal?.aborted) throw signal.reason;
        renameSync(temp, target);
        const dir = await open(dirname(target), fsConstants.O_RDONLY);
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      }
      const descriptor = ArtifactDescriptorSchema.parse({
        artifactId,
        type: request.type,
        relativePath,
        mimeType: request.mimeType,
        size: request.bytes.byteLength,
        sha256: hash,
        sensitivity: request.sensitivity,
      });
      if (request.type === "environment") {
        const projection = this.#safeRunPath(request.runId, "environment.json");
        const tempProjection = projection + "." + crypto.randomUUID() + ".tmp";
        const projectionHandle = await open(
          tempProjection,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
          0o600,
        );
        try {
          await projectionHandle.write(request.bytes);
          if (signal?.aborted) throw signal.reason;
          await projectionHandle.sync();
        } finally {
          await projectionHandle.close();
        }
        if (signal?.aborted) throw signal.reason;
        renameSync(tempProjection, projection);
        const projectionDirectory = await open(this.#runDir(request.runId), fsConstants.O_RDONLY);
        try {
          await projectionDirectory.sync();
        } finally {
          await projectionDirectory.close();
        }
      }
      const metadata = this.#safeRunPath(request.runId, `${dirname(relativePath)}/${hash}.descriptor.json`);
      const stored = StoredArtifactSchema.parse({ schemaVersion: 1, descriptor });
      try {
        const tempMetadata = metadata + "." + crypto.randomUUID() + ".tmp";
        const handle = await open(
          tempMetadata,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
          0o600,
        );
        try {
          await handle.write(jsonLine(stored));
          if (signal?.aborted) throw signal.reason;
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (signal?.aborted) throw signal.reason;
        renameSync(tempMetadata, metadata);
        const directory = await open(dirname(metadata), fsConstants.O_RDONLY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"))
          throw error;
        const existing = StoredArtifactSchema.parse(JSON.parse(await readFile(metadata, "utf8")) as unknown);
        if (existing.descriptor.sha256 !== hash || existing.descriptor.size !== descriptor.size)
          throw new Error("descriptor mismatch");
      }
      return ok(descriptor);
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
    signal?: AbortSignal,
  ): Promise<OperationResult<{ relativePath: string; sha256: string }>> {
    try {
      if (signal?.aborted) throw signal.reason;
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
        if (signal?.aborted) throw signal.reason;
        this.#fault("manifest-before-fsync");
        if (signal?.aborted) throw signal.reason;
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (signal?.aborted) throw signal.reason;
      this.#fault("manifest-before-rename");
      if (signal?.aborted) throw signal.reason;
      renameSync(temp, target);
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
    signal?: AbortSignal,
  ): Promise<OperationResult<{ relativePath: string; sha256: string }>> {
    try {
      if (signal?.aborted) throw signal.reason;
      const files = await readdir(this.#runDir(runId));
      const revisions = files
        .flatMap((name) => {
          const match = /^manifest\.v(\d+)\.json$/.exec(name);
          return match?.[1] ? [{ name, revision: Number(match[1]) }] : [];
        })
        .sort((a, b) => b.revision - a.revision);
      const previous = revisions[0];
      const previousBytes = previous ? await readFile(this.#safeRunPath(runId, previous.name)) : undefined;
      const previousManifest = previousBytes
        ? RunManifestSchema.parse(JSON.parse(previousBytes.toString("utf8")) as unknown)
        : undefined;
      const timeline = await readFile(this.#safeRunPath(runId, "timeline.jsonl"));
      const events = await this.readTimeline(runId);
      if (!events.ok) return events;
      const recovered = new Map(
        (previousManifest?.artifacts ?? []).map((artifact) => [artifact.artifactId, artifact]),
      );
      for (const artifact of artifacts) recovered.set(artifact.artifactId, artifact);
      for (const event of events.value) {
        if (event.type !== "ArtifactCommitted") continue;
        const ref = z
          .object({ artifactId: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), type: z.string() })
          .strict()
          .parse(event.data);
        const known = [...recovered.values()].find((artifact) => artifact.artifactId === ref.artifactId);
        if (known) {
          if (known.sha256 !== ref.sha256) throw new Error("descriptor reference mismatch");
          continue;
        }
        const metadata = this.#safeRunPath(
          runId,
          `${ref.type === "guest-diagnostics" ? "diagnostics" : "artifacts"}/${ref.sha256}.descriptor.json`,
        );
        const stored = StoredArtifactSchema.parse(JSON.parse(await readFile(metadata, "utf8")) as unknown);
        if (stored.descriptor.artifactId !== ref.artifactId || stored.descriptor.sha256 !== ref.sha256)
          throw new Error("descriptor identity");
        const content = await readFile(this.#safeRunPath(runId, stored.descriptor.relativePath));
        if (sha256(content) !== ref.sha256 || content.byteLength !== stored.descriptor.size)
          throw new Error("recovered artifact integrity");
        recovered.set(stored.descriptor.artifactId, stored.descriptor);
      }
      return await this.commitManifest({
        schemaVersion: 1,
        revision: (previous?.revision ?? 0) + 1,
        runId,
        buildVersion,
        eventCount: timeline.toString("utf8").trimEnd().split("\n").filter(Boolean).length,
        timelineSha256: sha256(timeline),
        result,
        artifacts: [...recovered.values()],
        ...(previousManifest?.configArtifact ? { configArtifact: previousManifest.configArtifact } : {}),
        ...(previousManifest?.environmentArtifact
          ? { environmentArtifact: previousManifest.environmentArtifact }
          : {}),
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

  async readTimeline(runId: RunId, signal?: AbortSignal): Promise<OperationResult<readonly EvidenceEvent[]>> {
    try {
      if (signal?.aborted) throw signal.reason;
      const raw = await readFile(this.#safeRunPath(runId, "timeline.jsonl"), "utf8").catch(
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
              .map((line) => parseEvidenceEvent(normalizeLegacyEvent(JSON.parse(line) as unknown)));
      events.forEach((event, index) => {
        if (event.sequence !== index + 1 || event.runId !== runId)
          throw new Error("sequence or run identity");
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
      this.#rejectSymlinks(this.#stateRoot, this.#stateRoot);
      this.#rejectSymlinks(this.#stateRoot, join(this.#stateRoot, "runs-index.jsonl"));
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
      const runDirectories = await readdir(join(this.#root, "runs"), { withFileTypes: true }).catch(
        (error: unknown) => {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
            return [];
          throw error;
        },
      );
      for (const entry of runDirectories)
        if (entry.isDirectory()) {
          const parsed = RunIdSchema.safeParse(entry.name);
          if (parsed.success) ids.add(parsed.data);
        }
      const listed: RunId[] = [];
      for (const runId of [...ids].sort()) {
        const exists = await lstat(this.#runDir(runId)).catch((error: unknown) => {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
            return undefined;
          throw error;
        });
        if (!exists) continue;
        if (!exists.isDirectory() || exists.isSymbolicLink()) throw new Error("unsafe Run entry");
        listed.push(runId);
      }
      return ok(listed);
    } catch {
      return err({
        code: "EvidenceCorrupted",
        phase: "evidence",
        message: "Run index could not be read.",
        retryDisposition: "notApplicable",
      });
    }
  }

  async listUnfinishedRuns(signal?: AbortSignal): Promise<OperationResult<readonly RunId[]>> {
    try {
      if (signal?.aborted) throw signal.reason;
      this.#rejectSymlinks(this.#root, join(this.#root, "runs"));
      const entries = await readdir(join(this.#root, "runs")).catch((error: unknown) => {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
          return [];
        throw error;
      });
      const unfinished: RunId[] = [];
      for (const entry of entries) {
        const runId = RunIdSchema.parse(entry);
        const timeline = await this.readTimeline(runId);
        if (!timeline.ok) {
          unfinished.push(runId);
          continue;
        }
        const files = await readdir(this.#runDir(runId));
        if (
          !timeline.value.some((event) => event.type === "RunFinished") ||
          !files.some((name) => /^manifest\.v[0-9]+\.json$/.test(name))
        )
          unfinished.push(runId);
      }
      return ok(unfinished);
    } catch {
      return err({
        code: "RecoveryRequired",
        phase: "evidence",
        message: "Unfinished Run inventory is invalid.",
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
      if (revisions.at(-1)?.revision !== 1) throw new Error("manifest history missing");
      for (let index = 0; index < revisions.length - 1; index += 1) {
        const current = revisions[index];
        const previous = revisions[index + 1];
        if (!current || !previous || current.revision !== previous.revision + 1)
          throw new Error("manifest revision gap");
        const currentManifest = RunManifestSchema.parse(
          JSON.parse(await readFile(this.#safeRunPath(runId, current.name), "utf8")) as unknown,
        );
        const previousBytes = await readFile(this.#safeRunPath(runId, previous.name));
        if (currentManifest.previousRevisionSha256 !== sha256(previousBytes))
          throw new Error("manifest revision chain");
      }
      const manifest = RunManifestSchema.parse(
        JSON.parse(await readFile(this.#safeRunPath(runId, latest.name), "utf8")) as unknown,
      );
      const timeline = await readFile(this.#safeRunPath(runId, "timeline.jsonl"));
      if (sha256(timeline) !== manifest.timelineSha256) throw new Error("timeline hash");
      const events = timeline
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .filter(Boolean)
        .map((line) => EvidenceEventSchema.parse(JSON.parse(line) as unknown));
      if (events.length !== manifest.eventCount) throw new Error("event count");
      if (manifest.runId !== runId || manifest.revision !== latest.revision)
        throw new Error("manifest identity");
      if (events.some((event, index) => event.runId !== runId || event.sequence !== index + 1))
        throw new Error("timeline identity or sequence");
      const finished = [...events].reverse().find((event) => event.type === "RunFinished");
      if (!finished || JSON.stringify(finished.data) !== JSON.stringify(manifest.result))
        throw new Error("manifest result mismatch");
      const artifactIds = new Set(manifest.artifacts.map((artifact) => artifact.artifactId));
      if (manifest.configArtifact && !artifactIds.has(manifest.configArtifact.artifactId))
        throw new Error("config artifact missing");
      if (manifest.environmentArtifact && !artifactIds.has(manifest.environmentArtifact.artifactId))
        throw new Error("environment artifact missing");
      const descriptorById = new Map(manifest.artifacts.map((artifact) => [artifact.artifactId, artifact]));
      const verifyRef = (input: unknown): void => {
        const ref = ArtifactRefSchema.parse(input);
        if (descriptorById.get(ref.artifactId)?.sha256 !== ref.sha256)
          throw new Error("artifact reference mismatch");
      };
      if (manifest.configArtifact) verifyRef(manifest.configArtifact);
      if (manifest.environmentArtifact) verifyRef(manifest.environmentArtifact);
      for (const event of events) {
        const data = event.data;
        if (typeof data !== "object" || data === null) continue;
        if (event.type === "ArtifactCommitted" && "artifactId" in data && "sha256" in data)
          verifyRef({ artifactId: data.artifactId, sha256: data.sha256 });
        if (event.type === "ObservationCaptured") {
          if ("screenshot" in data) verifyRef(data.screenshot);
          if ("uiSnapshot" in data) verifyRef(data.uiSnapshot);
        }
      }
      for (const artifact of manifest.artifacts) {
        const path = this.#safeRunPath(runId, artifact.relativePath);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe artifact");
        const bytes = await readFile(path);
        if (bytes.byteLength !== artifact.size || sha256(bytes) !== artifact.sha256)
          throw new Error("artifact hash");
        this.#validateSnapshot(artifact.type, bytes);
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
      const expected = new Map<string, string>();
      const timelineBytes = await readFile(this.#safeRunPath(runId, "timeline.jsonl"));
      expected.set("timeline.jsonl", verified.value.timelineSha256);
      for (let revision = 1; revision <= verified.value.revision; revision += 1) {
        const relative = `manifest.v${String(revision)}.json`;
        expected.set(relative, sha256(await readFile(this.#safeRunPath(runId, relative))));
      }
      for (const artifact of verified.value.artifacts) expected.set(artifact.relativePath, artifact.sha256);
      if (sha256(timelineBytes) !== verified.value.timelineSha256) throw new Error("timeline changed");
      for (const [relative, expectedHash] of expected) {
        const source = this.#safeRunPath(runId, relative);
        if (!(await lstat(source)).isFile()) throw new Error("export file type");
        const bytes = await readFile(source);
        if (sha256(bytes) !== expectedHash) throw new Error("export source changed");
        const target = join(destination, relative);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const temp = target + "." + crypto.randomUUID() + ".tmp";
        const handle = await open(
          temp,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
          0o600,
        );
        try {
          await handle.write(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        renameSync(temp, target);
      }
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

  async readManagedResource(signal?: AbortSignal): Promise<OperationResult<ManagedResourceRecord | null>> {
    try {
      if (signal?.aborted) throw signal.reason;
      this.#rejectSymlinks(this.#stateRoot, this.#stateRoot);
      this.#rejectSymlinks(this.#stateRoot, join(this.#stateRoot, "managed-resource.json"));
      const raw = await readFile(join(this.#stateRoot, "managed-resource.json"), "utf8").catch(
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        },
      );
      if (raw === null) return ok(null);
      const value: unknown = JSON.parse(raw);
      const current = ManagedResourceRecordSchema.safeParse(value);
      return ok(current.success ? current.data : LegacyManagedResourceRecordSchema.parse(value));
    } catch {
      return err({
        code: "RecoveryRequired",
        phase: "vm",
        message: "Managed resource state is invalid.",
        retryDisposition: "notApplicable",
      });
    }
  }

  async writeManagedResource(
    input: ManagedResourceRecord,
    signal?: AbortSignal,
  ): Promise<OperationResult<void>> {
    try {
      if (signal?.aborted) throw signal.reason;
      const record = ManagedResourceRecordSchema.parse(input);
      this.#rejectSymlinks(this.#stateRoot, this.#stateRoot);
      await mkdir(this.#stateRoot, { recursive: true, mode: 0o700 });
      const target = join(this.#stateRoot, "managed-resource.json");
      const temp = `${target}.${crypto.randomUUID()}.tmp`;
      const handle = await open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      try {
        await handle.write(`${JSON.stringify(record)}\n`);
        if (signal?.aborted) throw signal.reason;
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (signal?.aborted) throw signal.reason;
      renameSync(temp, target);
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

  async clearManagedResource(signal?: AbortSignal): Promise<OperationResult<void>> {
    try {
      if (signal?.aborted) throw signal.reason;
      try {
        unlinkSync(join(this.#stateRoot, "managed-resource.json"));
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"))
          throw error;
      }
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
    try {
      const entries = await readdir(join(this.#root, "runs")).catch(() => []);
      const runs = entries.flatMap((entry) => {
        const id = RunIdSchema.safeParse(entry);
        return id.success ? [id.data] : [];
      });
      const deleted: RunId[] = [];
      this.#rejectSymlinks(this.#stateRoot, this.#stateRoot);
      await mkdir(this.#stateRoot, { recursive: true, mode: 0o700 });
      const audit = await open(
        join(this.#stateRoot, "retention-audit.jsonl"),
        fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        for (const runId of runs) {
          const timeline = await this.readTimeline(runId);
          if (!timeline.ok) continue;
          const finished = [...timeline.value].reverse().find((event) => event.type === "RunFinished");
          if (!finished || now - Date.parse(finished.recordedAt) < maxAgeDays * 86_400_000) continue;
          await audit.write(
            `${JSON.stringify({ runId, phase: "planned", recordedAt: new Date(now).toISOString() })}\n`,
          );
          await audit.sync();
          try {
            await rm(this.#runDir(runId), { recursive: true, force: true });
            deleted.push(runId);
            await audit.write(
              `${JSON.stringify({ runId, phase: "completed", deletedAt: new Date(now).toISOString() })}\n`,
            );
          } catch {
            await audit.write(
              `${JSON.stringify({ runId, phase: "failed", recordedAt: new Date(now).toISOString() })}\n`,
            );
          }
          await audit.sync();
        }
      } finally {
        await audit.close();
      }
      const directory = await open(this.#stateRoot, fsConstants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return ok(deleted);
    } catch {
      return err({
        code: "EvidenceIncomplete",
        phase: "evidence",
        message: "Retention audit could not be committed.",
        retryDisposition: "notApplicable",
      });
    }
  }

  async listRetentionFailures(): Promise<OperationResult<readonly RunId[]>> {
    try {
      const raw = await readFile(join(this.#stateRoot, "retention-audit.jsonl"), "utf8").catch(
        (error: unknown) => {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
            return "";
          throw error;
        },
      );
      const status = new Map<RunId, "planned" | "completed" | "failed">();
      for (const line of raw.split("\n").filter(Boolean)) {
        const value = z
          .object({ runId: RunIdSchema, phase: z.enum(["planned", "completed", "failed"]) })
          .loose()
          .parse(JSON.parse(line) as unknown);
        status.set(value.runId, value.phase);
      }
      return ok([...status].flatMap(([id, phase]) => (phase === "failed" ? [id] : [])));
    } catch {
      return err({
        code: "EvidenceCorrupted",
        phase: "evidence",
        message: "Retention audit could not be verified.",
        retryDisposition: "notApplicable",
      });
    }
  }

  async #projectStep(event: EvidenceEvent, signal?: AbortSignal): Promise<void> {
    const data = z
      .object({ stepId: z.string(), status: z.enum(["completed", "failed", "notRun"]) })
      .strict()
      .parse(event.data);
    const steps = this.#safeRunPath(event.runId, "steps");
    await mkdir(steps, { recursive: true, mode: 0o700 });
    const projection = this.#safeRunPath(event.runId, `steps/${data.stepId}.json`);
    await this.#replaceProjection(
      projection,
      jsonLine({ schemaVersion: 1, runId: event.runId, stepId: data.stepId, status: data.status }),
      steps,
      signal,
    );
  }

  async #projectRecovery(event: EvidenceEvent, signal?: AbortSignal): Promise<void> {
    const recovery = join(this.#stateRoot, "recovery");
    this.#rejectSymlinks(this.#stateRoot, recovery);
    await mkdir(recovery, { recursive: true, mode: 0o700 });
    await this.#replaceProjection(
      join(recovery, event.runId + ".json"),
      jsonLine({
        schemaVersion: 1,
        runId: event.runId,
        status: event.type === "RunRecoveryStarted" ? "started" : "completed",
        recordedAt: event.recordedAt,
        elapsedMs: event.elapsedMs,
      }),
      recovery,
      signal,
    );
  }

  async #projectIndex(event: EvidenceEvent, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    this.#rejectSymlinks(this.#stateRoot, this.#stateRoot);
    await mkdir(this.#stateRoot, { recursive: true, mode: 0o700 });
    const indexPath = join(this.#stateRoot, "runs-index.jsonl");
    const indexEntry = `${JSON.stringify({ schemaVersion: 1, runId: event.runId, event: event.type, recordedAt: event.recordedAt })}\n`;
    const existing = await readFile(indexPath, "utf8").catch(() => "");
    const indexed = existing
      .split("\n")
      .filter(Boolean)
      .some((line) => line === indexEntry.trimEnd());
    if (!indexed)
      await this.#replaceProjection(
        indexPath,
        new TextEncoder().encode(existing + indexEntry),
        this.#stateRoot,
        signal,
      );
  }

  async #replaceProjection(
    target: string,
    bytes: Uint8Array,
    directory: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    const temp = target + "." + crypto.randomUUID() + ".tmp";
    const handle = await open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      await handle.write(bytes);
      if (signal?.aborted) throw signal.reason;
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (signal?.aborted) throw signal.reason;
    renameSync(temp, target);
    if (signal?.aborted) throw signal.reason;
    const parent = await open(directory, fsConstants.O_RDONLY);
    try {
      if (signal?.aborted) throw signal.reason;
      await parent.sync();
      if (signal?.aborted) throw signal.reason;
    } finally {
      await parent.close();
    }
  }

  #runDir(runId: RunId): string {
    const path = join(this.#root, "runs", runId);
    this.#rejectSymlinks(this.#root, path);
    return path;
  }

  #validateSnapshot(type: string, bytes: Uint8Array): void {
    if (type !== "display-screenshot" && type !== "window-screenshot") {
      const prefix = Buffer.from(bytes).subarray(0, Math.min(bytes.byteLength, 1_000_000)).toString("utf8");
      if (
        /(?:^|\n)(?:\[[^\n]{0,120}\])?(?:\s*\[[^\n]{0,120}\])?\s*(?:Proxying \[|Got response with status|Session created with session id:|Removing session .* from our master session list|Ending session, cause was|Mac2Driver host process has exited|Starting Mac2Driver host process:|\*\* TEST (?:FAILED|SUCCEEDED) \*\*)/mu.test(
          prefix,
        )
      )
        throw new Error("raw provider log");
    }
    if (type === "display-screenshot" || type === "window-screenshot") {
      const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      if (bytes.byteLength < signature.length || !signature.every((byte, index) => bytes[index] === byte))
        throw new Error("invalid png artifact");
      return;
    }
    if (type.startsWith("hook-")) return;
    if (
      type !== "effective-config" &&
      type !== "environment" &&
      type !== "guest-diagnostics" &&
      type !== "ui-snapshot"
    )
      throw new Error("unsupported artifact type");
    const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (type === "effective-config") ConfigSnapshotSchema.parse(input);
    else if (type === "environment") EnvironmentSnapshotSchema.parse(input);
    else if (type === "guest-diagnostics") ProviderLifecycleDiagnosticSchema.parse(input);
    else z.record(z.string(), z.unknown()).parse(input);
  }

  #rejectSymlinks(root: string, target: string): void {
    const absoluteRoot = resolve(root);
    const suffix = relative(absoluteRoot, resolve(target));
    if (suffix.startsWith(`..${sep}`) || suffix === "..") throw new Error("path escape");
    let current = absoluteRoot;
    for (const part of ["", ...suffix.split(sep).filter(Boolean)]) {
      if (part) current = join(current, part);
      try {
        if (lstatSync(current).isSymbolicLink()) throw new Error("symlink");
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"))
          throw error;
      }
    }
  }

  #canonicalRoot(input: string): string {
    const absolute = resolve(input);
    const missing: string[] = [];
    let current = absolute;
    for (;;) {
      try {
        const info = lstatSync(current);
        if (current === absolute && info.isSymbolicLink()) throw new Error("configured root is a symlink");
        return join(realpathSync(current), ...missing.reverse());
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"))
          throw error;
        const parent = dirname(current);
        if (parent === current) throw error;
        missing.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
        current = parent;
      }
    }
  }

  #safeRunPath(runId: RunId, relativePath: string): string {
    if (relativePath.startsWith("/") || relativePath.split("/").includes(".."))
      throw new Error("unsafe path");
    const root = this.#runDir(runId);
    const resolved = join(root, relativePath);
    if (!resolved.startsWith(`${root}/`)) throw new Error("path escape");
    this.#rejectSymlinks(this.#root, resolved);
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
