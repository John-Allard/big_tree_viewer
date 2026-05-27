import { useEffect, useState } from "react";
import App from "./App";
import AboutPage from "./AboutPage";
import ApiPage from "./ApiPage";
import SharePage from "./SharePage";

type SitePage = "viewer" | "about" | "api" | "share";

function currentSitePage(): SitePage {
  if (typeof window === "undefined") {
    return "viewer";
  }
  if (window.location.hash === "#about") {
    return "about";
  }
  if (window.location.hash === "#api") {
    return "api";
  }
  if (window.location.hash === "#share") {
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
    const isDocumentPage = page === "about" || page === "api" || page === "share";
    document.body.style.overflow = isDocumentPage ? "auto" : "hidden";
    document.body.style.overscrollBehavior = isDocumentPage ? "auto" : "none";
    document.title = page === "about"
      ? "Big Tree Viewer | About"
      : page === "api"
        ? "Big Tree Viewer | API"
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
  if (page === "share") {
    return <SharePage />;
  }
  return <App />;
}
