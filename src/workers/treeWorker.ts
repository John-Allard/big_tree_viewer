/// <reference lib="webworker" />

import { parseTreePayload } from "../lib/treeParser";
import type { ParseProgress, ParsedTreeResponse, ParseTreeError, WorkerRequest } from "../types/messages";
import type { WorkerTreePayload } from "../types/tree";

function postProgress(message: string): void {
  const response: ParseProgress = { type: "parse-progress", message };
  self.postMessage(response);
}

function yieldToLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function postParsed(payload: WorkerTreePayload, transfers: Transferable[]): void {
  const response: ParsedTreeResponse = { type: "parsed-tree", payload };
  self.postMessage(response, transfers);
}

function postError(error: unknown): void {
  const response: ParseTreeError = {
    type: "parse-error",
    message: error instanceof Error ? error.message : String(error),
  };
  self.postMessage(response);
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type !== "parse-tree") return;
  try {
    postProgress("Worker started.");
    await yieldToLoop();
    const { payload, transfers } = parseTreePayload(message.text, postProgress);
    await yieldToLoop();
    postProgress("Layout complete. Sending tree to UI...");
    await yieldToLoop();
    postParsed(payload, transfers);
  } catch (error) {
    postError(error);
  }
};
