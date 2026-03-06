import type { LayoutOrder, WorkerTreePayload } from "./tree";

export interface ParseTreeRequest {
  type: "parse-tree";
  text: string;
}

export interface ParsedTreeResponse {
  type: "parsed-tree";
  payload: WorkerTreePayload;
}

export interface ParseProgress {
  type: "parse-progress";
  message: string;
}

export interface ParseTreeError {
  type: "parse-error";
  message: string;
}

export interface RebuildLayoutsRequest {
  type: "rebuild-layouts";
  order: LayoutOrder;
}

export type WorkerRequest = ParseTreeRequest | RebuildLayoutsRequest;

export type WorkerResponse = ParsedTreeResponse | ParseProgress | ParseTreeError;
