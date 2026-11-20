import { useEffect, useState } from "react";
import { Link, NavLink, useLocation, useNavigation } from "react-router";

const sections = ["Nigeria", "Africa", "World", "Geopolitics", "History"];

export function Brand() {
  return (
    <Link className="brand" to="/" aria-label="GeoLens AI home">
      <svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true" fill="none">
        <circle cx="20" cy="20" r="17" stroke="currentColor" strokeWidth="1.6"/>
        <ellipse cx="20" cy="20" rx="8" ry="17" stroke="currentColor" strokeWidth="1.3"/>
        <path d="M4 20h32M8 11.5h24M8 28.5h24" stroke="currentColor" strokeWidth="1.3"/>
        <circle cx="30" cy="29" r="10" fill="var(--masthead)" stroke="var(--logo-accent)" strokeWidth="2.5"/>
        <path d="m37.5 36.5 7 7" stroke="var(--logo-accent)" strokeWidth="3" strokeLinecap="round"/>
        <path d="M26 29h8m-4-4v8" stroke="var(--logo-accent)" strokeWidth="1.25" strokeLinecap="round"/>
      </svg>
      <span>GeoLens <b>AI</b></span>
    </Link>
  );
}

export function Icon({ name }: { name: "search" | "account" | "theme" | "bookmark" | "share" }) {
  const shapes = {
    search: <><circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/></>,
    account: <><circle cx="12" cy="8" r="3.5"/><path d="M5 20v-2a7 7 0 0 1 14 0v2"/></>,
    theme: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>,
    bookmark: <path d="M6 3h12v18l-6-4-6 4z"/>,
    share: <><path d="M12 15V3m-4 4 4-4 4 4M5 12v8h14v-8"/></>,
  };
  return <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{shapes[name]}</svg>;
}

export function ReaderHeader() {
  const location = useLocation();
  const navigation = useNavigation();
  const [menu, setMenu] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);

  useEffect(() => {
    const stored = document.documentElement.dataset.theme;
    if (stored === "light" || stored === "dark") setTheme(stored);
  }, []);

  useEffect(() => { setMenu(false); }, [location.pathname]);

  function toggleTheme() {
    const current = theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try { localStorage.setItem("geolens-theme", next); } catch { /* Storage can be unavailable. */ }
  }

  return (
    <>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header>
        <div className="masthead">
          <div className="container masthead-inner">
            <Brand />
            <p className="tagline">Beyond the headlines. Understand the world.</p>
            <div className="masthead-actions">
              <Link to="/search" aria-label="Search"><Icon name="search" /><span>Search</span></Link>
              <Link to="/account" aria-label="Account"><Icon name="account" /><span>Account</span></Link>
              <button type="button" onClick={toggleTheme} aria-label="Toggle light or dark mode"><Icon name="theme" /></button>
            </div>
          </div>
        </div>
        <nav className="nav" aria-label="Main navigation">
          <div className="container nav-inner">
            <button type="button" className="menu-toggle" aria-expanded={menu} aria-controls="reader-navigation" onClick={() => setMenu(!menu)} onKeyDown={(event) => { if (event.key === "Escape") setMenu(false); }}>
              <span aria-hidden="true">☰</span> Menu
            </button>
            <div id="reader-navigation" className={menu ? "nav-links is-open" : "nav-links"} onKeyDown={(event) => {
              if (event.key === "Escape") {
                setMenu(false);
                document.querySelector<HTMLButtonElement>(".menu-toggle")?.focus();
              }
            }}>
              <NavLink to="/" end>Home</NavLink>
              {sections.map((label) => <NavLink key={label} to={"/section/" + label.toLowerCase()}>{label}</NavLink>)}
              <NavLink to="/factcheck">FactCheck <small>Planned</small></NavLink>
              <NavLink to="/ask">Ask GeoLens <small>Planned</small></NavLink>
            </div>
            <span className="preview-label"><span aria-hidden="true" /> Synthetic preview</span>
          </div>
        </nav>
      </header>
      <div className="navigation-status" role="status">{navigation.state === "loading" ? "Loading…" : ""}</div>
    </>
  );
}

export function ReaderFooter() {
  return (
    <footer className="reader-footer">
      <div className="container footer-inner">
        <Brand />
        <p>Beyond the headlines. Understand the world.</p>
        <span>Synthetic preview · Fictional editorial content</span>
      </div>
    </footer>
  );
}
