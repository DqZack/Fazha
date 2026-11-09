# Fazha: publish on GitHub and keep every order

GitHub only hosts web pages, so it cannot run `server.js`. Orders are saved by a free order server on Cloudflare instead. It answers the same addresses as `server.js`, so the site works the same. (Menu names on Cloudflare can differ slightly.)

## 1. Order server (free, no card, about 10 minutes)
1. Sign up at **dash.cloudflare.com**.
2. **Storage & databases → D1 SQL database → Create database**. Name it `fazha`.
3. **Workers & Pages → Create → Hello World**. Name it `fazha-orders`, Deploy, then **Edit code**. Delete everything, paste all of `worker.js`, Deploy.
4. In the worker: **Settings → Bindings → Add → D1 database**. Variable name `DB` (capitals), pick `fazha`, save.
5. **Settings → Variables and Secrets → Add**. Type **Secret**, name `ADMIN_PASSWORD`, value a **new long password**. Do not reuse the old one: it was visible in your files. Deploy.
6. Open your worker address (ends in `workers.dev`). You should see `{"ok":true,"database":true,"adminPassword":true}`.

## 2. GitHub
1. Edit `config.js` and paste the worker address between the quotes.
2. Upload `index.html`, `admin.html` and `config.js` to your repo.
3. Replace your workflow file in `.github/workflows/` with `deploy.yml`.
4. **Settings → Pages → Source: GitHub Actions**.
5. Do **not** upload `server.js`, `worker.js` or the `data` folder. The workflow also keeps them out of the website.

## 3. Use it
Open your site, tap **Log in**, use `drzackifaza@gmail.com` and the new password. Every customer's order appears, and approvals show on their side within a minute. `admin.html` is a plain list of orders.

## Good to know
- Free limits: 100,000 requests a day, 500 MB of orders.
- All orders are always listed. Pictures show for your 40 newest.
- Portfolio pictures: put the image in an `art` folder on GitHub and add `["art/name.jpg","Title","How I helped"]` to `FAZHA_ART` in `config.js`.
- Testing on your computer still works: `node server.js`, with `config.js` left empty.
