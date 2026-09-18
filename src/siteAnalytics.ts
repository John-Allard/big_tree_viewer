const PRODUCTION_HOSTS = new Set(["bigtreeviewer.net", "www.bigtreeviewer.net"]);

function analyticsPath(): string {
  const route = window.location.hash
    .replace(/^#\/?/, "")
    .split(/[/?&]/, 1)[0]
    .replace(/\/$/, "");

  switch (route) {
    case "about":
    case "api":
    case "faq":
    case "metadata":
    case "share":
    case "desktop":
    case "agentic-ai":
      return `/${route}`;
    case "example-tree":
      return "/faq";
    case "download":
      return "/desktop";
    default:
      return "/viewer";
  }
}

function analyticsReferrer(): string {
  if (!document.referrer) return "";
  try {
    return new URL(document.referrer).origin;
  } catch {
    return "";
  }
}

function sendPageView(endpoint: string, path: string): void {
  const url = new URL(endpoint);
  url.searchParams.set("p", path);
  url.searchParams.set("t", document.title);
  const referrer = analyticsReferrer();
  if (referrer) url.searchParams.set("r", referrer);
  url.searchParams.set("rnd", Math.random().toString(36).slice(2, 7));

  if (navigator.sendBeacon(url.toString())) return;

  const fallback = new Image(1, 1);
  fallback.alt = "";
  fallback.src = url.toString();
}

export function startSiteAnalytics(): void {
  const endpoint = import.meta.env.VITE_GOATCOUNTER_ENDPOINT?.trim();
  if (
    !endpoint
    || !PRODUCTION_HOSTS.has(window.location.hostname)
    || navigator.webdriver
    || (document.visibilityState as string) === "prerender"
    || window.self !== window.top
  ) {
    return;
  }

  let lastCountedPath = "";
  const countCurrentPage = (): void => {
    const path = analyticsPath();
    if (path === lastCountedPath) return;
    lastCountedPath = path;
    sendPageView(endpoint, path);
  };

  window.requestAnimationFrame(countCurrentPage);
  window.addEventListener("hashchange", () => {
    window.requestAnimationFrame(countCurrentPage);
  });
}
