export {};

declare global {
  interface Window {
    bigTreeViewerDesktop?: {
      consumePendingOpenPaths: () => Promise<string[]>;
      onOpenPaths: (callback: (paths: string[]) => void) => () => void;
      onMenuCommand: (callback: (command: "save-session" | "save-newick" | "load-settings" | "export-view" | "fit-view" | "toggle-side-panel" | "toggle-full-screen") => void) => () => void;
      openFiles: () => Promise<void>;
      grantFile: (path: string) => Promise<{ name: string; url: string }>;
      saveFile: (suggestedName: string, data: ArrayBuffer) => Promise<boolean>;
      onAgentRequest: (callback: (request: { id: string; operation: string; payload: Record<string, unknown> }) => void) => () => void;
      agentResult: (result: { id: string; ok: boolean; result?: unknown; message?: string }) => void;
      taxonomyCache?: {
        readArchive: (source: "ncbi" | "catalogue-of-life") => Promise<ArrayBuffer | null>;
        writeArchive: (source: "ncbi" | "catalogue-of-life", data: ArrayBuffer) => Promise<void>;
        readValue: (store: string, key: string) => Promise<unknown>;
        writeValue: (store: string, key: string, value: unknown) => Promise<void>;
        deleteValue: (store: string, key: string) => Promise<void>;
      };
      platform: "darwin" | "linux" | "win32";
    };
  }
}
