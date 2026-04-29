import React from "react";
import ReactDOM from "react-dom/client";
import SiteRoot from "./SiteRoot";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SiteRoot />
  </React.StrictMode>,
);
