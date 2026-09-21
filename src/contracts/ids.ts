import { z } from "zod";

const prefixedId = (prefix: string) =>
  z.string().regex(new RegExp("^" + prefix + "-[0-9a-z][0-9a-z-]{6,119}$"));

export const RunIdSchema = prefixedId("run").brand<"RunId">();
export const ActionIdSchema = prefixedId("action").brand<"ActionId">();
export const ObservationIdSchema = prefixedId("observation").brand<"ObservationId">();
export const AssertionIdSchema = prefixedId("assertion").brand<"AssertionId">();
export const ArtifactIdSchema = prefixedId("artifact").brand<"ArtifactId">();
export const SessionIdSchema = prefixedId("session").brand<"SessionId">();
export const WindowIdSchema = prefixedId("window").brand<"WindowId">();
export const ElementIdSchema = prefixedId("element").brand<"ElementId">();
export const LeaseIdSchema = prefixedId("lease").brand<"LeaseId">();
export const OperationIdSchema = prefixedId("operation").brand<"OperationId">();

export type RunId = z.infer<typeof RunIdSchema>;
export type ActionId = z.infer<typeof ActionIdSchema>;
export type ObservationId = z.infer<typeof ObservationIdSchema>;
export type AssertionId = z.infer<typeof AssertionIdSchema>;
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type WindowId = z.infer<typeof WindowIdSchema>;
export type ElementId = z.infer<typeof ElementIdSchema>;
export type LeaseId = z.infer<typeof LeaseIdSchema>;
export type OperationId = z.infer<typeof OperationIdSchema>;
