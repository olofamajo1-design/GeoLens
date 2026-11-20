import { isRouteErrorResponse, Link, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import { ReaderFooter, ReaderHeader } from "./components/reader/shell";
import type { Route } from "./+types/root";
import "./styles.css";

const restoreTheme = 'try { const theme = localStorage.getItem("geolens-theme"); if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme; } catch {}';

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <script dangerouslySetInnerHTML={{ __html: restoreTheme }} />
        <Meta />
        <Links />
      </head>
      <body>
        <ReaderHeader />
        {children}
        <ReaderFooter />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function Root() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const missing = isRouteErrorResponse(error) && error.status === 404;
  return (
    <main id="main-content" className="container reader-page" tabIndex={-1}>
      <title>{`${missing ? "Page not found" : "Something went wrong"} | GeoLens AI`}</title>
      <h1>{missing ? "Page not found" : "Something went wrong"}</h1>
      <p>{missing ? "This story or page is unavailable." : "The site couldn’t load this page. Please try again."}</p>
      <div className="button-row">
        {!missing && <button type="button" className="button" onClick={() => window.location.reload()}>Try again</button>}
        <Link className="button" to="/">Back to homepage</Link>
      </div>
    </main>
  );
}
