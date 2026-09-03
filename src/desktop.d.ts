export {};

declare global {
  interface Window {
    bigTreeViewerDesktop?: {
      consumePendingOpenPaths: () => Promise<string[]>;
      onOpenPaths: (callback: (paths: string[]) => void) => () => void;
      onMenuCommand: (callback: (command: "save-session" | "export-view" | "fit-view" | "toggle-side-panel" | "toggle-full-screen") => void) => () => void;
      grantFile: (path: string) => Promise<{ name: string; url: string }>;
      saveFile: (suggestedName: string, data: ArrayBuffer) => Promise<boolean>;
      platform: "darwin" | "linux" | "win32";
    };
  }
}
