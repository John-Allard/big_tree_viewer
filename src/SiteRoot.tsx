import { useEffect, useState } from "react";
import App from "./App";
import AboutPage from "./AboutPage";

type SitePage = "viewer" | "about";

function currentSitePage(): SitePage {
  if (typeof window === "undefined") {
    return "viewer";
  }
  return window.location.hash === "#about" ? "about" : "viewer";
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
    document.body.style.overflow = page === "about" ? "auto" : "hidden";
    document.body.style.overscrollBehavior = page === "about" ? "auto" : "none";
    document.title = page === "about" ? "Big Tree Viewer | About" : "Big Tree Viewer";
    return () => {
      document.body.style.overflow = "";
      document.body.style.overscrollBehavior = "";
    };
  }, [page]);

  return page === "about" ? <AboutPage /> : <App />;
}
