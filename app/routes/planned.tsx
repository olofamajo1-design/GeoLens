import { Link, useLocation } from "react-router";

const destinations = {
  "/factcheck": { title: "FactCheck", description: "Claim submissions and uploads will be available in a future milestone." },
  "/ask": { title: "Ask GeoLens", description: "Reader questions and private responses will be available in a future milestone." },
  "/account": { title: "Account", description: "Reader sign-in and synced bookmarks will be available in a future milestone. You can save articles on this device today." },
};

export default function Planned() {
  const pathname = useLocation().pathname.replace(/\/$/, "").toLowerCase();
  const destination = destinations[pathname as keyof typeof destinations];
  return (
    <main id="main-content" className="container reader-page" tabIndex={-1}>
      <title>{`${destination.title} | GeoLens AI`}</title>
      <div className="page-intro"><h1>{destination.title}</h1></div>
      <div className="empty-state">
        <h2>Unavailable in this preview</h2>
        <p>{destination.description}</p>
        <Link to="/">Back to homepage</Link>
      </div>
    </main>
  );
}
