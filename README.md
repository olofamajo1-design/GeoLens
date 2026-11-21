# GeoLens
An AI-powered global news and geopolitical intelligence platform that delivers verified news, historical context, balanced perspectives, fact-checking and interactive analysis through a multi-agent AI newsroom.

## Reader preview

Use Node 24.22.1 (see `.node-version`) and npm. From the repository root:

```sh
npm ci
npm run dev
```

Open http://localhost:5173. The reader includes a homepage, sections, search, and article detail. Its stories and generated editorial illustrations are synthetic. FactCheck, Ask GeoLens, and Account are marked as planned. Bookmarks and theme preferences are stored on the current device. The preview requires no account or database. `GET /health` reports synthetic mode.

```sh
npm run check
npm run preview
```

The check command generates types, runs unit tests, builds the Worker, and smoke-tests the built preview. After the build, open http://localhost:4173 for the production build running locally.

Run the Chromium reader tests against the built Worker:

```sh
npx playwright install chromium
npm run test:browser
```

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if an installed Chromium should be used. Set `GEOLENS_SCREENSHOTS` to a writable directory to capture desktop and mobile review images during the tests.

- [Local development and CI](docs/operations/development.md)
- [Foundation architecture](docs/architecture/foundation.md)
- [Newsroom contracts and editorial policy](docs/newsroom/contracts.md)
- [Integrated newsroom and synthetic demonstration](docs/architecture/newsroom-stage-5d.md)

## Local database security

See [Milestone 2 database security](docs/architecture/database-security.md) for the migration model and the disposable Supabase Auth, Storage, and authorization tests.

## Local news discovery pilot

See the [discovery pilot guide](docs/architecture/news-ingestion.md) for source permissions, restricted egress, fixture commands, and budget controls.
