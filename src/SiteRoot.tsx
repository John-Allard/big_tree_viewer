import { useEffect, useState } from "react";
import App from "./App";
import AboutPage from "./AboutPage";
import ApiPage from "./ApiPage";

type SitePage = "viewer" | "about" | "api";

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
    const isDocumentPage = page === "about" || page === "api";
    document.body.style.overflow = isDocumentPage ? "auto" : "hidden";
    document.body.style.overscrollBehavior = isDocumentPage ? "auto" : "none";
    document.title = page === "about"
      ? "Big Tree Viewer | About"
      : page === "api"
        ? "Big Tree Viewer | API"
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
  return <App />;
}
