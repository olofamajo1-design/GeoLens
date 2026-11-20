import { useEffect, useState } from "react";
import { Icon } from "./shell";

function readBookmarks(): string[] {
  const value: unknown = JSON.parse(localStorage.getItem("geolens-bookmarks") ?? "[]");
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function ArticleActions({ slug, title }: { slug: string; title: string }) {
  const [bookmarked, setBookmarked] = useState(false);
  const [message, setMessage] = useState("");
  const [shareUrl, setShareUrl] = useState("");

  useEffect(() => {
    try { setBookmarked(readBookmarks().includes(slug)); } catch { setBookmarked(false); }
  }, [slug]);

  function toggleBookmark() {
    try {
      const stored = readBookmarks();
      const exists = stored.includes(slug);
      const next = exists ? stored.filter((entry) => entry !== slug) : [...stored, slug];
      localStorage.setItem("geolens-bookmarks", JSON.stringify(next));
      setBookmarked(!exists);
      setMessage(exists ? "Bookmark removed." : "Bookmark saved on this device.");
    } catch { setMessage("Bookmarks are unavailable on this device."); }
  }

  async function share() {
    const url = new URL(window.location.pathname, window.location.origin).href;
    if (navigator.share) {
      try {
        await navigator.share({ title, url });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setMessage("Article link copied.");
    } catch {
      setShareUrl(url);
      setMessage("Copy the article link below.");
    }
  }

  return (
    <div className="article-actions">
      <div className="button-row">
        <button type="button" className="button button-quiet" aria-pressed={bookmarked} onClick={toggleBookmark}>
          <Icon name="bookmark" /> {bookmarked ? "Bookmarked" : "Bookmark"}
        </button>
        <button type="button" className="button button-quiet" onClick={share}><Icon name="share" /> Share</button>
      </div>
      <p className="action-status" role="status">{message}</p>
      {shareUrl && <label className="share-input">Article link <input readOnly value={shareUrl} onFocus={(event) => event.currentTarget.select()} /></label>}
    </div>
  );
}
