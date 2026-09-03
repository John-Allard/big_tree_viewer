export {};

declare global {
  interface Window {
    bigTreeViewerDesktop?: {
      consumePendingOpenPaths: () => Promise<string[]>;
      onOpenPaths: (callback: (paths: string[]) => void) => () => void;
      grantFile: (path: string) => Promise<{ name: string; url: string }>;
      platform: "darwin" | "linux" | "win32";
    };
  }
}
