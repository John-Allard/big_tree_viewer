import { useEffect, useState } from "react";
import App from "./App";
import AboutPage from "./AboutPage";
import ApiPage from "./ApiPage";
import FaqPage from "./FaqPage";
import SharePage from "./SharePage";

type SitePage = "viewer" | "about" | "api" | "faq" | "share";

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
  if (route === "share") {
    return "share";
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
    const isDocumentPage = page === "about" || page === "api" || page === "faq" || page === "share";
    document.body.style.overflow = isDocumentPage ? "auto" : "hidden";
    document.body.style.overscrollBehavior = isDocumentPage ? "auto" : "none";
    document.title = page === "about"
      ? "Big Tree Viewer | About"
      : page === "api"
        ? "Big Tree Viewer | API"
        : page === "faq"
          ? "Big Tree Viewer | FAQ"
          : page === "share"
            ? "Big Tree Viewer | Share sessions"
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
  if (page === "share") {
    return <SharePage />;
  }
  return <App />;
}
