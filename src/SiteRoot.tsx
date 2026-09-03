import { useEffect, useState } from "react";
import App from "./App";
import AboutPage from "./AboutPage";
import AgenticAiPage from "./AgenticAiPage";
import DesktopPage from "./DesktopPage";
import ApiPage from "./ApiPage";
import FaqPage from "./FaqPage";
import MetadataGuidePage from "./MetadataGuidePage";
import SharePage from "./SharePage";

type SitePage = "viewer" | "about" | "api" | "faq" | "metadata" | "share" | "desktop" | "agentic-ai";

function currentSitePage(): SitePage {
  if (typeof window === "undefined") {
    return "viewer";
  }
  const route = window.location.hash
    .replace(/^#\/?/, "")
    .split(/[/?&]/, 1)[0]
    .replace(/\/$/, "");
  if (route === "about") {
    return "about";
  }
  if (route === "api") {
    return "api";
  }
  if (route === "faq" || route === "example-tree") {
    return "faq";
  }
  if (route === "metadata") {
    return "metadata";
  }
  if (route === "share") {
    return "share";
  }
  if (route === "desktop" || route === "download") {
    return "desktop";
  }
  if (route === "agentic-ai") {
    return "agentic-ai";
  }
  return "viewer";
}

export default function SiteRoot() {
  const [page, setPage] = useState<SitePage>(() => currentSitePage());

  useEffect(() => {
    const syncPage = (): void => {
      setPage(currentSitePage());
    };
    window.addEventListener("hashchange", syncPage);
    syncPage();
    return () => {
      window.removeEventListener("hashchange", syncPage);
    };
  }, []);

  useEffect(() => {
    const isDocumentPage = page === "about" || page === "api" || page === "faq" || page === "metadata" || page === "share" || page === "desktop" || page === "agentic-ai";
    document.body.style.overflow = isDocumentPage ? "auto" : "hidden";
    document.body.style.overscrollBehavior = isDocumentPage ? "auto" : "none";
    document.title = page === "about"
      ? "Big Tree Viewer | About"
      : page === "api"
        ? "Big Tree Viewer | API"
        : page === "faq"
          ? "Big Tree Viewer | FAQ"
          : page === "metadata"
            ? "Big Tree Viewer | Metadata guide"
            : page === "share"
              ? "Big Tree Viewer | Share sessions"
              : page === "desktop"
                ? "Big Tree Viewer | Desktop app"
              : page === "agentic-ai"
                ? "Big Tree Viewer | Using BTV with agentic AI"
                : "Big Tree Viewer";
    return () => {
      document.body.style.overflow = "";
      document.body.style.overscrollBehavior = "";
    };
  }, [page]);

  if (page === "about") {
    return <AboutPage />;
  }
  if (page === "api") {
    return <ApiPage />;
  }
  if (page === "faq") {
    return <FaqPage />;
  }
  if (page === "metadata") {
    return <MetadataGuidePage />;
  }
  if (page === "share") {
    return <SharePage />;
  }
  if (page === "desktop") {
    return <DesktopPage />;
  }
  if (page === "agentic-ai") {
    return <AgenticAiPage />;
  }
  return <App />;
}
