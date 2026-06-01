import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";

function normalizeSessionUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (parsed.hostname === "www.dropbox.com" || parsed.hostname === "dropbox.com") {
      parsed.hostname = "dl.dropboxusercontent.com";
      parsed.searchParams.delete("raw");
      parsed.searchParams.set("dl", "1");
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export default function SharePage() {
  const [sessionUrl, setSessionUrl] = useState("");
  const [hideDownloadNewick, setHideDownloadNewick] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const normalizedSessionUrl = useMemo(() => normalizeSessionUrl(sessionUrl), [sessionUrl]);
  const shareLink = useMemo(() => {
    if (!normalizedSessionUrl || typeof window === "undefined") {
      return "";
    }
    const params = new URLSearchParams({ btv_session_url: normalizedSessionUrl });
    if (hideDownloadNewick) {
      params.set("btv_hide_download_newick", "1");
    }
    return `${window.location.origin}${import.meta.env.BASE_URL}?${params.toString()}`;
  }, [hideDownloadNewick, normalizedSessionUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !shareLink) {
      return;
    }
    void QRCode.toCanvas(canvas, shareLink, {
      margin: 1,
      width: 220,
      color: {
        dark: "#0f172a",
        light: "#ffffff",
      },
    });
  }, [shareLink]);

  const copyShareLink = async (): Promise<void> => {
    if (!shareLink || typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    await navigator.clipboard.writeText(shareLink);
    setCopyStatus("Copied.");
    window.setTimeout(() => setCopyStatus(""), 1600);
  };

  const openTestLink = (): void => {
    if (!shareLink || typeof window === "undefined") {
      return;
    }
    window.open(shareLink, "_blank", "noopener,noreferrer");
  };

  return (
    <main className="about-page share-page">
      <div className="about-page-frame">
        <nav className="site-doc-nav" aria-label="Documentation">
          <a href={`${import.meta.env.BASE_URL}#`}>Viewer</a>
          <a href={`${import.meta.env.BASE_URL}#about`}>About</a>
          <a href={`${import.meta.env.BASE_URL}#faq`}>FAQ</a>
          <a href={`${import.meta.env.BASE_URL}#share`} aria-current="page">Share sessions</a>
          <a href={`${import.meta.env.BASE_URL}#api`}>API</a>
        </nav>

        <header className="about-header">
          <div>
            <p className="about-kicker">Big Tree Viewer</p>
            <h1>How to share your tree session</h1>
            <p className="about-author-line">
              A saved session contains the tree, visual settings, metadata,
              manual colors, collapsed clades, taxonomy mappings, and the
              current viewport. If the session is saved after taxonomy mapping,
              other users can open the mapped tree without downloading the NCBI
              taxonomy dump.
            </p>
          </div>
          <a className="about-top-link" href={`${import.meta.env.BASE_URL}#`}>
            Back to viewer
          </a>
        </header>

        <section className="share-flow">
          <section className="api-doc-section">
            <h2>1. Save a session file</h2>
            <p>
              In the viewer Data panel, click Save Session. Big Tree Viewer saves
              a compressed `.btvsession` file that can be reloaded locally or
              shared through a static file URL.
            </p>
            <img
              className="share-panel-shot"
              src={`${import.meta.env.BASE_URL}about/save-session-panel.png`}
              alt="Big Tree Viewer interface with the Save Session button highlighted in the Data panel."
              loading="eager"
            />
          </section>

          <section className="api-doc-section">
            <h2>2. Upload the session somewhere with a static URL</h2>
            <p>
              The file must be reachable by a browser as a direct URL and the
              host must allow cross-origin fetches. Good options include:
            </p>
            <dl className="share-host-list">
              <div>
                <dt>Dropbox</dt>
                <dd>
                  Copy a normal Dropbox shared link and paste it into step 3.
                  Big Tree Viewer will convert the link to a
                  `dl.dropboxusercontent.com` direct-file URL automatically before
                  generating the share URL.
                </dd>
              </div>
              <div>
                <dt>Hugging Face Dataset repo</dt>
                <dd>Upload the session file to a dataset repository and use the file&apos;s `resolve/main/...` URL.</dd>
              </div>
              <div>
                <dt>OSF</dt>
                <dd>Good for academic project sharing. Use the file&apos;s direct download URL when available.</dd>
              </div>
              <div>
                <dt>Figshare</dt>
                <dd>Upload the session file as a research output and use the direct download URL for the file.</dd>
              </div>
              <div>
                <dt>Zenodo</dt>
                <dd>Upload the session file as part of a record and use the file download URL.</dd>
              </div>
              <div>
                <dt>GitHub</dt>
                <dd>Use a raw file URL or GitHub Pages URL if the file fits GitHub limits.</dd>
              </div>
              <div>
                <dt>Google Drive</dt>
                <dd>
                  Not suitable for direct BTV session links. Google Drive share
                  and download links do not provide the browser CORS access BTV
                  needs, and large files can return confirmation pages instead
                  of the session file.
                </dd>
              </div>
            </dl>
          </section>

          <section className="api-doc-section">
            <h2>3. Build a Big Tree Viewer share link</h2>
            <div className="share-builder-grid">
              <div>
                <label className="share-url-field">
                  <span>Static session file URL</span>
                  <input
                    type="url"
                    value={sessionUrl}
                    onChange={(event) => setSessionUrl(event.target.value)}
                    placeholder="https://example.org/path/my-tree.btvsession"
                  />
                </label>
                {sessionUrl && !normalizedSessionUrl ? (
                  <p className="share-error">Enter a full http or https URL.</p>
                ) : null}
                <label className="share-url-field">
                  <span>Share link</span>
                  <textarea value={shareLink} readOnly rows={4} placeholder="Paste a session URL above." />
                </label>
                <label className="share-option-toggle">
                  <input
                    type="checkbox"
                    checked={hideDownloadNewick}
                    onChange={(event) => setHideDownloadNewick(event.target.checked)}
                  />
                  <span>Hide the Download Newick button for this shared view</span>
                </label>
                <p className="share-note">
                  This hides the casual download control in the viewer. The
                  session file still contains the tree, so use this only as a
                  presentation safeguard, not as data protection.
                </p>
                <div className="share-actions">
                  <button type="button" onClick={copyShareLink} disabled={!shareLink}>Copy link</button>
                  <button type="button" onClick={openTestLink} disabled={!shareLink}>Test in new tab</button>
                  {copyStatus ? <span>{copyStatus}</span> : null}
                </div>
              </div>
              <div className="share-qr-frame" aria-live="polite">
                {shareLink ? (
                  <canvas ref={canvasRef} aria-label="QR code for the Big Tree Viewer session link" />
                ) : (
                  <p>Paste a static session URL to generate a QR code.</p>
                )}
              </div>
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}
