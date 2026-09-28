import { z } from "zod";
import {
  ApplicationDescriptorSchema,
  ApplicationTargetSchema,
  type ApplicationDescriptor,
  type ApplicationTarget,
  err,
  ok,
  type GuestPort,
  type SensitiveDataPolicy,
  type OperationId,
  type OperationResult,
  type ProbeResult,
  type ProviderReceipt,
  RunIdSchema,
  ProbeResultSchema,
  ProviderReceiptSchema,
  CompatibilityProbeSchema,
  type IdGenerator,
  AppiumStartResultSchema,
  ProviderLifecycleDiagnosticSchema,
  ProviderLifecycleEventSchema,
  ProviderTerminationEventTypeSchema,
} from "../../contracts/index.js";
import { runProcess } from "./process-runner.js";
import { appiumLifecycleFilterProgram } from "./lifecycle-filter.js";

const receipt = (operationId: OperationId, startedAt: string): ProviderReceipt =>
  ProviderReceiptSchema.parse({
    provider: "tart-exec",
    operationId,
    dispatch: "dispatched",
    outcome: "succeeded",
    startedAt,
    finishedAt: new Date().toISOString(),
  });

const applicationRoots = [
  "/Applications/",
  "/System/Applications/",
  "/System/Applications/Utilities/",
  "/System/Cryptexes/App/System/Applications/",
  "/Users/admin/Applications/",
] as const;

export const parseApplicationInventoryPaths = (input: string): readonly string[] => {
  if (Buffer.byteLength(input, "utf8") > 1_000_000) throw new Error("Application inventory too large.");
  const paths = input
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((path) => path.length <= 1024 && path.toLocaleLowerCase().endsWith(".app"))
    .filter((path) => applicationRoots.some((root) => path.startsWith(root)));
  if (paths.length > 2_000) throw new Error("Application inventory has too many paths.");
  return [...new Set(paths)];
};

export const parseApplicationMetadata = (
  path: string,
  bundleId: string,
  version?: string,
): ApplicationDescriptor => {
  const fallbackName = path.slice(path.lastIndexOf("/") + 1, -4);
  return ApplicationDescriptorSchema.parse({
    name: fallbackName.normalize("NFC"),
    bundleId: bundleId.trim(),
    ...(version?.trim() ? { version: version.trim() } : {}),
    location: path.startsWith("/Users/") ? "user" : "system",
  });
};

export class TartExecGuestAdapter implements GuestPort {
  #elementOriginActions = false;
  constructor(
    private readonly tart = "tart",
    private readonly sensitive?: SensitiveDataPolicy,
    private readonly registerChannel?: (
      channelId: OperationId,
      channel: { endpoint: string; elementOriginActions: boolean },
    ) => void,
    private readonly ids: IdGenerator = {
      next: () => {
        throw new Error("Guest logical ID generator is unavailable.");
      },
    },
  ) {}
  #nativeName(resourceId: string): string {
    return `mcu-${RunIdSchema.parse(resourceId)}`;
  }
  async probe(
    cloneName: string,
    expected: {
      buildIdentity: string;
      bundleId: string;
      compatibility: {
        appiumMajor: 3;
        appium: string;
        mac2: string;
        wdaSha256: string;
        guestMacOS: string;
        xcode: string;
        fixtureBuild: string;
      };
    },
    signal: AbortSignal,
  ): Promise<OperationResult<ProbeResult>> {
    expected = CompatibilityProbeSchema.parse(expected);
    const start = performance.now();
    const observedAt = new Date().toISOString();
    const fixedCommands: readonly [string, readonly string[]][] = [
      ["macos", ["/usr/bin/sw_vers", "-productVersion"]],
      ["xcode", ["/usr/bin/xcodebuild", "-version"]],
      ["appium", ["/usr/bin/env", "appium", "--version"]],
      ["drivers", ["/usr/bin/env", "appium", "driver", "list", "--installed", "--json"]],
      [
        "wda",
        [
          "/bin/zsh",
          "-lc",
          "driver=/Users/admin/mcu-provisioning/toolchain/node_modules/appium-mac2-driver; test -d $driver/WebDriverAgentMac; find $driver/WebDriverAgentMac -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}'",
        ],
      ],
      ["digest", ["/bin/cat", "/etc/macos-computer-use/image-digest"]],
      ["fixture", ["/bin/cat", "/etc/macos-computer-use/fixture-metadata.json"]],
      ["windowserver", ["/usr/bin/pgrep", "-x", "WindowServer"]],
    ];
    const outputs = new Map<string, string>();
    let failed = false;
    let actual:
      | {
          guestMacOS: string;
          xcode: string;
          appium: string;
          mac2: string;
          wdaSha256: string;
          buildIdentity: string;
          fixtureBuild: string;
          bundleId: string;
          windowServerReady: boolean;
        }
      | undefined;
    for (const [name, command] of fixedCommands) {
      const result = await runProcess(this.tart, ["exec", this.#nativeName(cloneName), ...command], signal);
      if (result.code !== 0) {
        failed = true;
        break;
      }
      outputs.set(name, result.stdout.trim());
    }
    let metadataValid = false;
    try {
      const fixture: unknown = JSON.parse(outputs.get("fixture") ?? "");
      const record = z
        .object({ bundleId: z.string(), version: z.string().optional(), build: z.string() })
        .strict()
        .parse(fixture);
      const drivers: unknown = JSON.parse(outputs.get("drivers") ?? "");
      const driverMetadata = z
        .object({ mac2: z.object({ version: z.literal("4.3.5") }).loose() })
        .loose()
        .parse(drivers);
      actual = {
        guestMacOS: outputs.get("macos") ?? "",
        xcode: (outputs.get("xcode") ?? "").split("\n")[0]?.replace(/^Xcode /, "") ?? "",
        appium: outputs.get("appium") ?? "",
        mac2: driverMetadata.mac2.version,
        wdaSha256: outputs.get("wda") ?? "",
        buildIdentity: outputs.get("digest") ?? "",
        fixtureBuild: record.build,
        bundleId: record.bundleId,
        windowServerReady: (outputs.get("windowserver") ?? "").length > 0,
      };
      metadataValid =
        actual.guestMacOS === expected.compatibility.guestMacOS &&
        actual.xcode === expected.compatibility.xcode &&
        actual.appium.split(".")[0] === String(expected.compatibility.appiumMajor) &&
        actual.appium === expected.compatibility.appium &&
        actual.mac2 === expected.compatibility.mac2 &&
        actual.wdaSha256 === expected.compatibility.wdaSha256 &&
        actual.buildIdentity === expected.buildIdentity &&
        actual.bundleId === expected.bundleId &&
        actual.fixtureBuild === expected.compatibility.fixtureBuild &&
        actual.windowServerReady;
      this.#elementOriginActions = metadataValid && actual.mac2 === "4.3.5";
    } catch {
      metadataValid = false;
      this.#elementOriginActions = false;
    }
    return ok(
      ProbeResultSchema.parse({
        status: !failed && metadataValid ? "ready" : signal.aborted ? "notReady" : "failed",
        observedAt,
        validForMs: 120_000,
        durationMs: performance.now() - start,
        ...(actual ? { actual } : {}),
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
    if (rules.length === 0) return ok(receipt(this.ids.next("operation") as OperationId, startedAt));
    const allowRules = rules.flatMap((rule) =>
      rule.ports.map(
        (port) => `pass out quick proto ${rule.protocol} to ${rule.cidr} port ${String(port)} keep state`,
      ),
    );
    const pfRules = [
      "set skip on lo0",
      "pass out quick proto udp from any port 68 to any port 67 keep state",
      "pass in quick proto tcp to any port 4723 keep state",
      ...allowRules,
      "block drop out quick all",
    ].join("\n");
    const encodedRules = Buffer.from(pfRules + String.fromCharCode(10)).toString("base64");
    const command = `set -e; umask 077; root=/tmp/macos-computer-use/${cloneName}; mkdir -p $root; printf %s ${encodedRules} | base64 -D > $root/network.pf; sudo -n /sbin/pfctl -nf $root/network.pf; sudo -n /sbin/pfctl -f $root/network.pf; sudo -n /sbin/pfctl -E; sudo -n /sbin/pfctl -s info | grep -q "Status: Enabled"; sudo -n /sbin/pfctl -sr | grep -q "block drop out quick all"`;
    const result = await runProcess(
      this.tart,
      ["exec", this.#nativeName(cloneName), "/bin/zsh", "-lc", command],
      signal,
    );
    if (result.code !== 0)
      return err({
        code: "ProviderFailure",
        phase: "guest",
        message: "Guest network policy could not be applied.",
        retryDisposition: "notApplicable",
      });
    return ok(receipt(this.ids.next("operation") as OperationId, startedAt));
  }
  async resolveApplication(
    cloneName: string,
    target: ApplicationTarget,
    signal: AbortSignal,
  ): Promise<OperationResult<ApplicationDescriptor>> {
    target = ApplicationTargetSchema.parse(target);
    const inventory = await runProcess(
      this.tart,
      [
        "exec",
        this.#nativeName(cloneName),
        "/bin/zsh",
        "-lc",
        "for root in /Applications /System/Applications /System/Cryptexes/App/System/Applications /Users/admin/Applications; do [ ! -d $root ] || /usr/bin/find $root -maxdepth 2 -type d -name '*.app'; done",
      ],
      signal,
      1_000_000,
    );
    if (inventory.code !== 0)
      return err({
        code: signal.aborted ? "Cancelled" : "ProviderFailure",
        phase: "guest",
        message: "Installed application inventory is unavailable.",
        retryDisposition: "safe",
        ...(signal.aborted ? { dispatch: "notDispatched" as const } : {}),
      });
    try {
      const expected = target.name.toLocaleLowerCase("en-US");
      const paths = parseApplicationInventoryPaths(inventory.stdout).filter(
        (path) =>
          path
            .slice(path.lastIndexOf("/") + 1, -4)
            .normalize("NFC")
            .toLocaleLowerCase("en-US") === expected,
      );
      if (paths.length !== 1)
        return err({
          code: paths.length === 0 ? "ApplicationNotFound" : "ApplicationAmbiguous",
          phase: "guest",
          message:
            paths.length === 0
              ? "No installed GUI application matches the requested display name."
              : "Multiple installed GUI applications match the requested display name.",
          retryDisposition: "notApplicable",
        });
      const path = paths[0] as string;
      const bundleId = await runProcess(
        this.tart,
        [
          "exec",
          this.#nativeName(cloneName),
          "/usr/bin/plutil",
          "-extract",
          "CFBundleIdentifier",
          "raw",
          "-o",
          "-",
          `${path}/Contents/Info.plist`,
        ],
        signal,
        4096,
      );
      if (bundleId.code !== 0) throw new Error("metadata");
      const version = await runProcess(
        this.tart,
        [
          "exec",
          this.#nativeName(cloneName),
          "/usr/bin/plutil",
          "-extract",
          "CFBundleShortVersionString",
          "raw",
          "-o",
          "-",
          `${path}/Contents/Info.plist`,
        ],
        signal,
        4096,
      );
      return ok(
        parseApplicationMetadata(path, bundleId.stdout, version.code === 0 ? version.stdout : undefined),
      );
    } catch {
      return err({
        code: "ProviderFailure",
        phase: "guest",
        message: "Installed application inventory is invalid.",
        retryDisposition: "notApplicable",
      });
    }
  }
  async startAppium(
    cloneName: string,
    signal: AbortSignal,
  ): Promise<OperationResult<{ channelId: OperationId; receipt: ProviderReceipt }>> {
    const startedAt = new Date().toISOString();
    const guestRoot = `/tmp/macos-computer-use/${cloneName}`;
    const result = await runProcess(
      this.tart,
      [
        "exec",
        this.#nativeName(cloneName),
        "/bin/zsh",
        "-lc",
        `set -e; umask 077; mkdir -p ${guestRoot}; if [ -f ${guestRoot}/appium.pid ]; then pid=$(cat ${guestRoot}/appium.pid); case $pid in (""|*[!0-9]*) exit 22;; esac; if kill -0 $pid 2>/dev/null; then exit 0; fi; fi; : > ${guestRoot}/lifecycle.jsonl; rm -f ${guestRoot}/appium.pipe; mkfifo -m 600 ${guestRoot}/appium.pipe; nohup /usr/bin/awk '${appiumLifecycleFilterProgram}' < ${guestRoot}/appium.pipe >> ${guestRoot}/lifecycle.jsonl 2>/dev/null & echo $! > ${guestRoot}/filter.pid; (ulimit -f 20480; exec nohup appium --address 0.0.0.0 --port 4723 --log-no-colors --log-level debug) > ${guestRoot}/appium.pipe 2>&1 < /dev/null & echo $! > ${guestRoot}/appium.pid`,
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
    const ip = await runProcess(
      this.tart,
      ["ip", this.#nativeName(cloneName), "--resolver", "agent", "--wait", "30"],
      signal,
    );
    const address = ip.stdout.trim();
    if (ip.code !== 0 || !/^[0-9a-f:.]+$/i.test(address))
      return err({
        code: "ProviderFailure",
        phase: "guest",
        message: "Guest control address is unavailable.",
        retryDisposition: "safe",
      });
    const endpoint = `http://${address.includes(":") ? `[${address}]` : address}:4723`;
    try {
      const response = await fetch(`${endpoint}/status`, { signal });
      const status: unknown = await response.json();
      if (
        !response.ok ||
        !z
          .object({ value: z.object({ ready: z.literal(true) }).loose() })
          .loose()
          .safeParse(status).success
      )
        throw new Error("not ready");
    } catch {
      return err({
        code: "SessionUnavailable",
        phase: "guest",
        message: "Guest Appium readiness has not passed.",
        retryDisposition: "safe",
      });
    }
    const started = receipt(this.ids.next("operation") as OperationId, startedAt);
    this.registerChannel?.(started.operationId, {
      endpoint,
      elementOriginActions: this.#elementOriginActions,
    });
    return ok(AppiumStartResultSchema.parse({ channelId: started.operationId, receipt: started }));
  }
  async stopAppium(cloneName: string, signal: AbortSignal): Promise<OperationResult<ProviderReceipt>> {
    const startedAt = new Date().toISOString();
    const result = await runProcess(
      this.tart,
      [
        "exec",
        this.#nativeName(cloneName),
        "/bin/zsh",
        "-lc",
        `set -e; root=/tmp/macos-computer-use/${cloneName}; [ -e $root/appium.pid ] || exit 0; [ -f $root/appium.pid ] && [ ! -L $root/appium.pid ] || exit 22; pid=$(cat $root/appium.pid); case $pid in (""|*[!0-9]*) exit 22;; esac; command=$(/bin/ps -p $pid -o command=) || exit 0; case $command in (*appium*--port*4723*) kill -TERM $pid;; (*) exit 23;; esac; for attempt in 1 2 3 4 5; do kill -0 $pid 2>/dev/null || exit 0; /bin/sleep 1; done; exit 24`,
      ],
      signal,
    );
    if (result.code === 0) return ok(receipt(this.ids.next("operation") as OperationId, startedAt));
    return err({
      code: "CleanupFailed",
      phase: "cleanup",
      message: "Guest Appium could not be stopped.",
      retryDisposition: "safe",
    });
  }
  async exportDiagnostics(
    cloneName: string,
    limits: { maxFileBytes: number; maxTotalBytes: number },
    signal: AbortSignal,
  ): Promise<OperationResult<Uint8Array>> {
    return this.#exportLifecycleDiagnostics(cloneName, limits, signal);
  }

  async #exportLifecycleDiagnostics(
    cloneName: string,
    limits: { maxFileBytes: number; maxTotalBytes: number },
    signal: AbortSignal,
  ): Promise<OperationResult<Uint8Array>> {
    try {
      const root = `/tmp/macos-computer-use/${cloneName}`;
      const command = `set -e; zmodload zsh/system; [ ! -L /tmp/macos-computer-use ] && [ ! -L ${root} ] || exit 22; [ -e ${root}/lifecycle.jsonl ] || exit 25; sysopen -r -o nofollow -u diagnostic_fd -- ${root}/lifecycle.jsonl || exit 22; metadata=$(stat -f '%HT %z' /dev/fd/$diagnostic_fd) || exit 22; type=\${metadata% *}; size=\${metadata##* }; [ "$type" = "Regular File" ] || exit 22; [ $size -le ${String(limits.maxFileBytes)} ] || exit 21; base64 <&$diagnostic_fd | tr -d '\n'`;
      const journal = await runProcess(
        this.tart,
        ["exec", this.#nativeName(cloneName), "/bin/zsh", "-lc", command],
        signal,
        Math.min(14_000_000, limits.maxFileBytes * 2),
      );
      if (journal.code !== 0) throw new Error("journal");
      const encoded = journal.stdout.trim();
      const journalBytes = Buffer.from(encoded, "base64");
      if (journalBytes.byteLength > limits.maxFileBytes || journalBytes.toString("base64") !== encoded)
        throw new Error("encoding");
      const events = new TextDecoder("utf-8", { fatal: true })
        .decode(journalBytes)
        .split("\n")
        .filter(Boolean)
        .map((line) => ProviderLifecycleEventSchema.parse(JSON.parse(line) as unknown));
      const ip = await runProcess(
        this.tart,
        ["ip", this.#nativeName(cloneName), "--resolver", "agent", "--wait", "30"],
        signal,
        4096,
      );
      const address = ip.stdout.trim();
      if (ip.code !== 0 || !/^[0-9a-f:.]+$/i.test(address)) throw new Error("address");
      const endpoint = `http://${address.includes(":") ? `[${address}]` : address}:4723`;
      const status = await fetch(`${endpoint}/status`, { signal })
        .then(async (response) => ({ response, value: await response.json() }))
        .catch(() => undefined);
      const sessionsResponse = await fetch(`${endpoint}/appium/sessions`, { signal })
        .then(async (response) => ({ response, value: await response.json() }))
        .catch(() => undefined);
      const ready = z.object({ value: z.object({ ready: z.literal(true) }).loose() }).loose();
      const sessions = z
        .object({ value: z.array(z.unknown()).max(16) })
        .loose()
        .safeParse(sessionsResponse?.value);
      const state = await runProcess(
        this.tart,
        [
          "exec",
          this.#nativeName(cloneName),
          "/bin/zsh",
          "-lc",
          "appium=0; xcodebuild=0; wda=0; pgrep -f 'appium.*--port 4723' >/dev/null && appium=1; pgrep -x xcodebuild >/dev/null && xcodebuild=1; pgrep -x WebDriverAgentRunner-Runner >/dev/null && wda=1; wda_status=unavailable; curl -fsS http://127.0.0.1:10100/status >/dev/null 2>&1 && wda_status=ready; printf '%s %s %s %s\\n' $appium $xcodebuild $wda $wda_status",
        ],
        signal,
        4096,
      );
      const stateMatch = /^(0|1) (0|1) (0|1) (ready|unavailable)\n?$/.exec(state.stdout);
      if (state.code !== 0 || !stateMatch) throw new Error("state");
      const recordedAt = new Date().toISOString();
      const appendExit = (source: "appium" | "xcodebuild" | "wda"): void => {
        events.push(
          ProviderLifecycleEventSchema.parse({
            sequence: events.length + 1,
            recordedAt,
            source,
            event: "processExited",
            cause: "providerExit",
            observedBeforeCleanup: true,
          }),
        );
      };
      if (events.some((event) => event.source === "appium") && stateMatch[1] !== "1") appendExit("appium");
      if (events.some((event) => event.source === "wda") && stateMatch[2] !== "1") appendExit("xcodebuild");
      if (events.some((event) => event.source === "wda") && stateMatch[3] !== "1") appendExit("wda");
      const knownOuterSessions = new Set(
        events.flatMap((event) =>
          event.event === "sessionCreated" && event.source === "appium" ? [event.alias] : [],
        ),
      );
      for (const event of events)
        if (event.event === "sessionRemoved" && event.source === "appium")
          knownOuterSessions.delete(event.alias);
      const activeSessionCount = sessions.success
        ? sessions.data.value.length
        : stateMatch[1] === "1"
          ? knownOuterSessions.size
          : 0;
      const terminal = events.find(
        (event) => ProviderTerminationEventTypeSchema.safeParse(event.event).success,
      );
      const diagnostic = ProviderLifecycleDiagnosticSchema.parse({
        schemaVersion: 1,
        compatibility: { appium: "3.7.0", mac2: "4.3.5" },
        events,
        snapshot: {
          capturedAt: new Date().toISOString(),
          observedBeforeCleanup: true,
          appiumStatus:
            status?.response.ok === true && ready.safeParse(status.value).success ? "ready" : "unavailable",
          wdaStatus: stateMatch[4],
          activeSessionCount,
          processes: {
            appium: stateMatch[1] === "1",
            xcodebuild: stateMatch[2] === "1",
            wda: stateMatch[3] === "1",
          },
        },
        ...(terminal
          ? {
              earliestTermination: {
                sequence: terminal.sequence,
                source: terminal.source,
                event: terminal.event,
                ...("alias" in terminal ? { alias: terminal.alias } : {}),
                ...("cause" in terminal ? { cause: terminal.cause } : {}),
              },
            }
          : {}),
      });
      const bytes = new TextEncoder().encode(JSON.stringify(diagnostic));
      if (bytes.byteLength > limits.maxFileBytes || bytes.byteLength > limits.maxTotalBytes)
        throw new Error("limit");
      return ok(bytes);
    } catch {
      return err({
        code: "EvidenceIncomplete",
        phase: "evidence",
        message: "Guest lifecycle diagnostic validation failed.",
        retryDisposition: "notApplicable",
      });
    }
  }
}
