import React from "react";
import ReactDOM from "react-dom/client";
import SiteRoot from "./SiteRoot";
import { startSiteAnalytics } from "./siteAnalytics";
import "./styles.css";

startSiteAnalytics();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SiteRoot />
  </React.StrictMode>,
);
