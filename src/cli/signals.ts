export const installTerminationHandlers = (
  controller: AbortController,
  processLike: {
    once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
    removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  } = process,
): (() => void) => {
  const interrupt = (): void => controller.abort(new Error("Interrupted by operator."));
  const terminate = (): void => controller.abort(new Error("Terminated by operator."));
  processLike.once("SIGINT", interrupt);
  processLike.once("SIGTERM", terminate);
  return () => {
    processLike.removeListener("SIGINT", interrupt);
    processLike.removeListener("SIGTERM", terminate);
  };
};
