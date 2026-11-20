# GeoLens
An AI-powered global news and geopolitical intelligence platform that delivers verified news, historical context, balanced perspectives, fact-checking and interactive analysis through a multi-agent AI newsroom.

## Foundation preview

Use Node 24.22.1 (see `.node-version`) and npm. From the repository root:

```sh
npm ci
npm run dev
```

Open http://localhost:5173. The home page shows the eight approved newsroom roles and the result of a server-side synthetic agent task. `GET /health` reports the current synthetic mode. The preview uses fictional data and requires no accounts, credentials, database, or provider access.

```sh
npm run check
npm run preview
```

The check command generates types, runs unit tests, builds the Worker, and smoke-tests the built preview. After the build, open http://localhost:4173 for the production build running locally.

- [Local development and CI](docs/operations/development.md)
- [Foundation architecture](docs/architecture/foundation.md)
- [Newsroom contracts and editorial policy](docs/newsroom/contracts.md)
