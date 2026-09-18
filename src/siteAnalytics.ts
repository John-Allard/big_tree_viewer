type GoatCounterOptions = {
  endpoint?: string;
  no_events?: boolean;
  no_onload?: boolean;
  count?: (values?: {
    path?: string;
    title?: string;
    referrer?: string;
  }) => void;
};

declare global {
  interface Window {
    goatcounter?: GoatCounterOptions;
  }
}

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

export function startSiteAnalytics(): void {
  const endpoint = import.meta.env.VITE_GOATCOUNTER_ENDPOINT?.trim();
  if (!endpoint || !PRODUCTION_HOSTS.has(window.location.hostname)) return;

  let lastCountedPath = "";
  const countCurrentPage = (): void => {
    const path = analyticsPath();
    if (path === lastCountedPath || !window.goatcounter?.count) return;
    lastCountedPath = path;
    window.goatcounter.count({
      path,
      title: document.title,
      referrer: analyticsReferrer(),
    });
  };

  window.goatcounter = {
    ...window.goatcounter,
    endpoint,
    no_events: true,
    no_onload: true,
  };

  const script = document.createElement("script");
  script.async = true;
  script.src = "https://gc.zgo.at/count.v5.js";
  script.crossOrigin = "anonymous";
  script.integrity = "sha384-atnOLvQb9t+jTSipvd75X2yginT4PjVbqDdlJAmxMm+wYElFmeR6EmLP5bYeoRVQ";
  script.dataset.goatcounter = endpoint;
  script.addEventListener("load", countCurrentPage, { once: true });
  document.head.append(script);

  window.addEventListener("hashchange", () => {
    window.requestAnimationFrame(countCurrentPage);
  });
}
