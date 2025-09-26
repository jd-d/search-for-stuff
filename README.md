# Nitter Analytics Architecture

This repository contains everything needed to run a personal analytics dashboard for your own tweets via Nitter. The project pairs a static GitHub Pages front-end with a Cloudflare Worker that handles authentication, Nitter proxying, and rate limiting.

## Repository layout

```
/docs/                     # Static front-end served by GitHub Pages
  index.html               # UI for login, instance selection, tweet analysis
  app.js                   # Client logic: login flow, fetch + render tweets, CSV export
  styles.css               # Glassmorphism-inspired styling
  nitter_instances.json    # Candidate Nitter instances (editable)
/cloudflare-worker/
  worker.js                # Cloudflare Worker implementing auth, proxy, rate limits
README.md                  # You are here
```

## Front-end (GitHub Pages)

* Pure HTML/CSS/JS—no secrets or build tooling required.
* Prompts for a username/password, then exchanges them for a short-lived token stored in `sessionStorage`.
* Lets you pick a Nitter instance, override the worker URL, and fetch up to 50 tweets at a time.
* Computes average likes/retweets/replies and renders the raw tweets in a table.
* Provides CSV export to continue analysis offline.
* Includes a manual instance checker to quickly see which mirrors are currently available.

To publish the front-end, enable GitHub Pages on the `docs/` folder in your repository settings. Once published, set the GitHub Pages origin in the Worker environment variable `ALLOWED_ORIGIN` so the proxy only accepts calls from your site.

## Cloudflare Worker

`cloudflare-worker/worker.js` exposes three endpoints under your Worker domain:

| Endpoint | Method | Description |
| --- | --- | --- |
| `/login` | `POST` | Validates credentials stored as Worker secrets and returns a signed token (HMAC JWT) that expires after one hour. |
| `/check-instance` | `GET` | Accepts a `url` query parameter, probes the instance, and returns `{ ok: boolean }` for the front-end badge view. |
| `/tweets` | `GET` | Accepts `instance`, `handle`, and optional `count` parameters. Fetches the Nitter RSS feed (HTML fallback), parses tweet text + engagement stats, and returns JSON. |

### Security & reliability features

* **Credential storage** – `AUTH_USERNAME`, `AUTH_PASSWORD`, and `JWT_SECRET` are read from the Worker environment and never exposed to the client.
* **Short-lived tokens** – Tokens expire after 3600 seconds and are validated on every request.
* **CORS enforcement** – Responses include `Access-Control-Allow-Origin` scoped to `ALLOWED_ORIGIN` so only your GitHub Pages deployment can call the Worker.
* **Rate limiting** – Simple in-memory per-identifier limits guard against abuse (60 API calls/min per token, 10 login attempts/min per IP).
* **Proxying** – Nitter requests originate from the Worker, preventing CORS issues and hiding your browsing pattern.
* **RSS-first parsing** – Uses RSS when available to minimise scraping. HTML parsing is a fallback when RSS is unavailable.

### Deploying the Worker

1. Create a new Worker and upload `cloudflare-worker/worker.js` (either copy/paste or via Wrangler).
2. Configure environment variables/secrets:
   * `AUTH_USERNAME`
   * `AUTH_PASSWORD`
   * `JWT_SECRET` – use a long random string.
   * `ALLOWED_ORIGIN` – your GitHub Pages origin, e.g. `https://<user>.github.io`.
3. Deploy the Worker and note the domain, e.g. `https://nitter-proxy.example.workers.dev`.
4. Enter that URL into the dashboard (saved in `sessionStorage` for convenience).

> **Responsible use:** Respect the usage policies of each Nitter instance. Keep counts low (the UI defaults to 20 tweets and caps at 50) and prefer RSS so you minimise scraping overhead.

## Local testing

Because everything is static, you can open `docs/index.html` directly in a browser for development. To test against a Worker locally, update the Worker URL field within the UI and make sure your browser origin matches `ALLOWED_ORIGIN` or temporarily set `ALLOWED_ORIGIN` to `*` while developing.

## Extending the project

* Add charts or richer analytics by extending `docs/app.js` once you have the JSON payload.
* Update `docs/nitter_instances.json` with mirrors you trust.
* Integrate `wrangler.toml` if you prefer scripted Worker deployments.

Happy analysing!
