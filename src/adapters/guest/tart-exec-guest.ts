import { createHash } from "node:crypto";
import {
  err,
  ok,
  type GuestPort,
  type OperationId,
  type OperationResult,
  type ProbeResult,
  type ProviderReceipt,
  ProbeResultSchema,
  ProviderReceiptSchema,
} from "../../contracts/index.js";
import { runProcess } from "../process-runner.js";

const op = (label: string): OperationId =>
  `operation-${createHash("sha256").update(label).digest("hex").slice(0, 24)}` as OperationId;
const receipt = (label: string, startedAt: string): ProviderReceipt =>
  ProviderReceiptSchema.parse({
    provider: "tart-exec",
    operationId: op(`${label}-${startedAt}`),
    dispatch: "dispatched",
    outcome: "succeeded",
    startedAt,
    finishedAt: new Date().toISOString(),
  });

export class TartExecGuestAdapter implements GuestPort {
  constructor(private readonly tart = "tart") {}
  async probe(
    cloneName: string,
    expected: {
      imageDigest: string;
      bundleId: string;
      compatibility: {
        appiumMajor: 3;
        mac2: string;
        guestMacOS: string;
        xcode: string;
        fixtureBuild: string;
      };
    },
    signal: AbortSignal,
  ): Promise<OperationResult<ProbeResult>> {
    const start = performance.now();
    const observedAt = new Date().toISOString();
    const fixedCommands: readonly [string, readonly string[]][] = [
      ["macos", ["/usr/bin/sw_vers", "-productVersion"]],
      ["xcode", ["/usr/bin/xcodebuild", "-version"]],
      ["appium", ["/usr/bin/env", "appium", "--version"]],
      ["drivers", ["/usr/bin/env", "appium", "driver", "list", "--installed", "--json"]],
      ["digest", ["/bin/cat", "/etc/macos-computer-use/image-digest"]],
      ["fixture", ["/bin/cat", "/etc/macos-computer-use/fixture-metadata.json"]],
      ["windowserver", ["/usr/bin/pgrep", "-x", "WindowServer"]],
    ];
    const outputs = new Map<string, string>();
    let failed = false;
    for (const [name, command] of fixedCommands) {
      const result = await runProcess(this.tart, ["exec", cloneName, ...command], signal);
      if (result.code !== 0) {
        failed = true;
        break;
      }
      outputs.set(name, result.stdout.trim());
    }
    let metadataValid = false;
    try {
      const fixture: unknown = JSON.parse(outputs.get("fixture") ?? "");
      const record =
        typeof fixture === "object" && fixture !== null ? (fixture as Record<string, unknown>) : {};
      const drivers: unknown = JSON.parse(outputs.get("drivers") ?? "");
      const driverText = JSON.stringify(drivers);
      metadataValid =
        outputs.get("macos") === expected.compatibility.guestMacOS &&
        (outputs.get("xcode") ?? "").split("\n")[0] === `Xcode ${expected.compatibility.xcode}` &&
        (outputs.get("appium") ?? "").split(".")[0] === String(expected.compatibility.appiumMajor) &&
        driverText.includes(`"mac2"`) &&
        driverText.includes(expected.compatibility.mac2) &&
        outputs.get("digest") === expected.imageDigest &&
        record.bundleId === expected.bundleId &&
        record.build === expected.compatibility.fixtureBuild;
    } catch {
      metadataValid = false;
    }
    return ok(
      ProbeResultSchema.parse({
        status: !failed && metadataValid ? "ready" : signal.aborted ? "notReady" : "failed",
        observedAt,
        validForMs: 5_000,
        durationMs: performance.now() - start,
        ...(!failed && metadataValid ? {} : { reason: "Guest compatibility probe failed." }),
      }),
    );
  }
  async configureNetwork(
    cloneName: string,
    rules: readonly { cidr: string; ports: readonly number[]; protocol: "tcp" | "udp" }[],
    signal: AbortSignal,
  ): Promise<OperationResult<ProviderReceipt>> {
    const startedAt = new Date().toISOString();
    if (rules.length === 0) return ok(receipt("network-host-only", startedAt));
    const allowRules = rules.flatMap((rule) =>
      rule.ports.map(
        (port) => `pass out quick proto ${rule.protocol} to ${rule.cidr} port ${String(port)} keep state`,
      ),
    );
    const pfRules = [
      "set skip on lo0",
      "pass out quick proto tcp from any port 4723 keep state",
      ...allowRules,
      "block drop out quick all",
    ].join("\n");
    const encodedRules = Buffer.from(pfRules).toString("base64");
    const command = `printf %s ${encodedRules} | base64 -D | sudo pfctl -a macos-computer-use -f - && sudo pfctl -E`;
    const result = await runProcess(this.tart, ["exec", cloneName, "/bin/zsh", "-lc", command], signal);
    if (result.code !== 0)
      return err({
        code: "ProviderFailure",
        phase: "guest",
        message: "Guest network policy could not be applied.",
        retryDisposition: "notApplicable",
      });
    return ok(receipt("network-policy", startedAt));
  }
  async startAppium(
    cloneName: string,
    signal: AbortSignal,
  ): Promise<OperationResult<{ endpoint: string; receipt: ProviderReceipt }>> {
    const startedAt = new Date().toISOString();
    const guestRoot = `/tmp/macos-computer-use/${cloneName}`;
    const result = await runProcess(
      this.tart,
      [
        "exec",
        cloneName,
        "/bin/zsh",
        "-lc",
        `mkdir -p ${guestRoot} && nohup appium --address 0.0.0.0 --port 4723 > ${guestRoot}/appium.log 2>&1 &`,
      ],
      signal,
    );
    if (result.code !== 0)
      return err({
        code: "ProviderFailure",
        phase: "guest",
        message: "Guest Appium could not be started.",
        retryDisposition: "safe",
        dispatch: "notDispatched",
      });
    const ip = await runProcess(this.tart, ["ip", cloneName, "--resolver", "agent", "--wait", "30"], signal);
    const address = ip.stdout.trim();
    if (ip.code !== 0 || !/^[0-9a-f:.]+$/i.test(address))
      return err({
        code: "ProviderFailure",
        phase: "guest",
        message: "Guest control address is unavailable.",
        retryDisposition: "safe",
      });
    return ok({ endpoint: `http://${address}:4723`, receipt: receipt("appium-start", startedAt) });
  }
  async stopAppium(cloneName: string, signal: AbortSignal): Promise<OperationResult<ProviderReceipt>> {
    const startedAt = new Date().toISOString();
    const result = await runProcess(
      this.tart,
      ["exec", cloneName, "/usr/bin/pkill", "-f", "appium.*4723"],
      signal,
    );
    if (result.code === 0 || result.code === 1) return ok(receipt("appium-stop", startedAt));
    return err({
      code: "CleanupFailed",
      phase: "cleanup",
      message: "Guest Appium could not be stopped.",
      retryDisposition: "safe",
    });
  }
  async exportDiagnostics(cloneName: string, signal: AbortSignal): Promise<OperationResult<Uint8Array>> {
    const root = `/tmp/macos-computer-use/${cloneName}`;
    const records: { path: string; data: string; sha256: string; size: number }[] = [];
    let totalBytes = 0;
    for (const name of ["appium.log", "wda.log", "guest.log"]) {
      const command = `if [ -f ${root}/${name} ] && [ ! -L ${root}/${name} ]; then size=$(stat -f %z ${root}/${name}); [ $size -le 10485760 ] || exit 21; base64 < ${root}/${name} | tr -d '\n'; fi`;
      const result = await runProcess(
        this.tart,
        ["exec", cloneName, "/bin/zsh", "-lc", command],
        signal,
        14_000_000,
      );
      if (result.code !== 0)
        return err({
          code: "EvidenceIncomplete",
          phase: "evidence",
          message: "Guest diagnostic validation failed.",
          retryDisposition: "notApplicable",
        });
      const data = result.stdout.trim();
      if (data) {
        const bytes = Buffer.from(data, "base64");
        totalBytes += bytes.byteLength;
        if (totalBytes > 20 * 1024 * 1024)
          return err({
            code: "EvidenceIncomplete",
            phase: "evidence",
            message: "Guest diagnostics exceed the aggregate limit.",
            retryDisposition: "notApplicable",
          });
        let decoded: string;
        try {
          decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          return err({
            code: "EvidenceIncomplete",
            phase: "evidence",
            message: "Guest diagnostic is not valid UTF-8 text.",
            retryDisposition: "notApplicable",
          });
        }
        const sanitized = decoded.replace(
          /((?:token|api[_-]?key|authorization|cookie|secret|password)\s*[:=]\s*)[^\s]+/gi,
          "$1[REDACTED]",
        );
        if (
          /(?:token|api[_-]?key|authorization|cookie|secret|password)\s*[:=]\s*(?!\[REDACTED\])[^\s]+/i.test(
            sanitized,
          )
        )
          return err({
            code: "EvidenceIncomplete",
            phase: "evidence",
            message: "Guest diagnostic sanitization could not be proven complete.",
            retryDisposition: "notApplicable",
          });
        const sanitizedBytes = Buffer.from(sanitized);
        records.push({
          path: name,
          data: sanitizedBytes.toString("base64"),
          sha256: createHash("sha256").update(sanitizedBytes).digest("hex"),
          size: sanitizedBytes.byteLength,
        });
      }
    }
    return ok(new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, files: records })));
  }
}
