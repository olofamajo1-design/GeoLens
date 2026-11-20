import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("section/:section", "routes/section.tsx"),
  route("articles/:slug", "routes/article.tsx"),
  route("search", "routes/search.tsx"),
  route("factcheck", "routes/planned.tsx", { id: "factcheck" }),
  route("ask", "routes/planned.tsx", { id: "ask" }),
  route("account", "routes/planned.tsx", { id: "account" }),
  route("health", "routes/health.ts"),
] satisfies RouteConfig;
