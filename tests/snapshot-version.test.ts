import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ConfigSnapshotSchema,
  EnvironmentSnapshotSchema,
  GatewayConfigSchema,
} from "../src/contracts/index.js";

describe("version 2 Evidence snapshots", () => {
  it("validates sanitized effective configuration and rejects legacy relabeling", async () => {
    const config = GatewayConfigSchema.parse(
      JSON.parse(await readFile("examples/config.example.json", "utf8")) as unknown,
    );
    const snapshot = {
      schemaVersion: 2,
      image: config.image,
      aut: { bundleId: config.aut.bundleId },
      timeouts: config.timeouts,
      evidence: {
        retentionDays: config.evidence.retentionDays,
        maxArtifactBytes: config.evidence.maxArtifactBytes,
        maxRunBytes: config.evidence.maxRunBytes,
      },
      network: config.network,
      secrets: config.secrets,
      compatibility: config.compatibility,
    };
    expect(ConfigSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(ConfigSnapshotSchema.safeParse({ ...snapshot, schemaVersion: 1 }).success).toBe(false);
    expect(ConfigSnapshotSchema.safeParse({ ...snapshot, state: config.state }).success).toBe(false);
    const environment = {
      schemaVersion: 2,
      imageDigest: config.image.digest,
      buildIdentity: config.image.buildIdentity,
      compatibility: config.compatibility,
      bundleId: config.aut.bundleId,
      actual: {
        guestMacOS: config.compatibility.guestMacOS,
        xcode: config.compatibility.xcode,
        appium: config.compatibility.appium,
        mac2: config.compatibility.mac2,
        wdaSha256: config.compatibility.wdaSha256,
        buildIdentity: config.image.buildIdentity,
        fixtureBuild: config.compatibility.fixtureBuild,
        bundleId: config.aut.bundleId,
        windowServerReady: true,
        automationPermissionReady: true,
      },
    };
    expect(EnvironmentSnapshotSchema.safeParse(environment).success).toBe(true);
    expect(EnvironmentSnapshotSchema.safeParse({ ...environment, schemaVersion: 1 }).success).toBe(false);
    expect(EnvironmentSnapshotSchema.safeParse({ ...environment, cloneName: "native-name" }).success).toBe(
      false,
    );
  });
});
