import { Download, MonitorDown } from "lucide-react";

const RELEASE_BASE = "https://github.com/John-Allard/big_tree_viewer/releases/latest/download";

type DesktopPlatform = "macos" | "windows" | "linux" | "unknown";

function detectPlatform(): DesktopPlatform {
  if (typeof navigator === "undefined") return "unknown";
  const value = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  if (value.includes("mac")) return "macos";
  if (value.includes("win")) return "windows";
  if (value.includes("linux")) return "linux";
  return "unknown";
}

const downloads = [
  {
    platform: "macos" as const,
    title: "macOS",
    detail: "Universal build for Apple silicon and Intel Macs",
    href: `${RELEASE_BASE}/Big-Tree-Viewer-macOS-universal.dmg`,
  },
  {
    platform: "windows" as const,
    title: "Windows",
    detail: "64-bit installer for Windows 10 and 11",
    href: `${RELEASE_BASE}/Big-Tree-Viewer-Windows-x64.exe`,
  },
  {
    platform: "linux" as const,
    title: "Linux AppImage",
    detail: "Portable 64-bit application",
    href: `${RELEASE_BASE}/Big-Tree-Viewer-Linux-x86_64.AppImage`,
  },
  {
    platform: "linux" as const,
    title: "Linux Debian package",
    detail: "64-bit .deb package for Debian and Ubuntu",
    href: `${RELEASE_BASE}/Big-Tree-Viewer-Linux-x86_64.deb`,
  },
];

export default function DesktopPage() {
  const platform = detectPlatform();
  const recommended = downloads.find((download) => download.platform === platform);

  return (
    <main className="about-page desktop-page">
      <div className="about-page-frame">
        <nav className="site-doc-nav" aria-label="Documentation">
          <a href={`${import.meta.env.BASE_URL}#`}>Viewer</a>
          <a href={`${import.meta.env.BASE_URL}#about`}>About</a>
          <a href={`${import.meta.env.BASE_URL}#faq`}>FAQ</a>
          <a href={`${import.meta.env.BASE_URL}#metadata`}>Metadata</a>
          <a href={`${import.meta.env.BASE_URL}#share`}>Share sessions</a>
          <a href={`${import.meta.env.BASE_URL}#desktop`} aria-current="page">Desktop app</a>
          <a href={`${import.meta.env.BASE_URL}#api`}>API</a>
          <a href={`${import.meta.env.BASE_URL}#agentic-ai`}>Agentic AI</a>
        </nav>

        <header className="about-header">
          <div>
            <p className="about-kicker">Big Tree Viewer</p>
            <h1>Desktop app</h1>
            <p className="about-author-line">
              Use Big Tree Viewer offline and open supported tree and session files directly from your computer.
              The desktop and web editions use the same viewer and rendering code.
            </p>
          </div>
          <a className="about-top-link" href={`${import.meta.env.BASE_URL}#`}>Open web viewer</a>
        </header>

        {recommended ? (
          <section className="desktop-recommended" aria-labelledby="recommended-download-title">
            <MonitorDown aria-hidden="true" />
            <div>
              <h2 id="recommended-download-title">Recommended for this computer</h2>
              <p>{recommended.detail}</p>
            </div>
            <a className="desktop-download-button" href={recommended.href}>
              <Download aria-hidden="true" />
              Download for {recommended.title}
            </a>
          </section>
        ) : null}

        <section className="desktop-downloads" aria-labelledby="all-downloads-title">
          <h2 id="all-downloads-title">All downloads</h2>
          <div className="desktop-download-list">
            {downloads.map((download) => (
              <div className="desktop-download-row" key={download.title}>
                <div>
                  <h3>{download.title}</h3>
                  <p>{download.detail}</p>
                </div>
                <a href={download.href} aria-label={`Download Big Tree Viewer for ${download.title}`}>
                  <Download aria-hidden="true" />
                  Download
                </a>
              </div>
            ))}
          </div>
          <p className="desktop-release-link">
            Previous versions and release notes are available on the{" "}
            <a href="https://github.com/John-Allard/big_tree_viewer/releases" target="_blank" rel="noreferrer">GitHub releases page</a>.
          </p>
        </section>

        <section className="api-doc-section">
          <h2>Opening tree files</h2>
          <p>
            The installer registers common Newick and NEXUS extensions, including <code>.nwk</code>, <code>.newick</code>,
            {" "}<code>.tre</code>, <code>.nex</code>, and <code>.nexus</code>, plus <code>.btvsession</code> files.
            You can make Big Tree Viewer the default application for any of these formats in your operating system.
          </p>
        </section>
      </div>
    </main>
  );
}
