import type { LeaseId } from "../contracts/index.js";

export type ProbeState = {
  status: "ready" | "notReady" | "failed";
  observedAtMs: number;
  validForMs: number;
};

export class EnvironmentState {
  lifecycle: "allocating" | "active" | "cleaningUp" | "closed" | "failed" = "allocating";
  generation = 1;
  readonly readiness = new Map<"vm" | "guest" | "driver" | "app", ProbeState>();
  readonly lease: { id: LeaseId; expiresAtMs: number; revoked: boolean };

  constructor(leaseId: LeaseId, expiresAtMs: number) {
    this.lease = { id: leaseId, expiresAtMs, revoked: false };
  }

  recordReady(layer: "vm" | "guest" | "driver" | "app", nowMs: number, validForMs: number): void {
    this.readiness.set(layer, { status: "ready", observedAtMs: nowMs, validForMs });
  }

  activate(nowMs: number): void {
    const ready = ["vm", "guest", "driver", "app"].every((layer) => {
      const probe = this.readiness.get(layer as "vm" | "guest" | "driver" | "app");
      return probe?.status === "ready" && nowMs - probe.observedAtMs <= probe.validForMs;
    });
    if (!ready) throw new Error("Environment is not ready.");
    this.lifecycle = "active";
  }

  requireLease(leaseId: LeaseId, nowMs: number): void {
    if (this.lease.revoked || this.lease.id !== leaseId || nowMs > this.lease.expiresAtMs)
      throw new Error("LeaseExpired");
  }

  requireReady(nowMs: number): void {
    const fresh = ["vm", "guest", "driver", "app"].every((layer) => {
      const probe = this.readiness.get(layer as "vm" | "guest" | "driver" | "app");
      return probe?.status === "ready" && nowMs - probe.observedAtMs <= probe.validForMs;
    });
    if (this.lifecycle !== "active" || !fresh) throw new Error("ReadinessExpired");
  }

  reconstruct(): void {
    this.generation += 1;
    this.readiness.clear();
    this.lifecycle = "allocating";
  }

  beginCleanup(): void {
    this.lease.revoked = true;
    this.lifecycle = "cleaningUp";
  }
  close(success: boolean): void {
    this.lifecycle = success ? "closed" : "failed";
  }
}
