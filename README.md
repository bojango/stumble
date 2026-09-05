# Stumble

A one-person, mobile-first StumbleUpon-style internet randomiser. The actual destination loads as a normal Safari page; a Safari userscript overlays **dislike / STUMBLE / like / preferences** controls and keeps your learning data locally on-device.

## Architecture

- **Safari / Userscripts** injects `stumble.user.js` on normal web pages.
- **GitHub Pages** hosts the landing page and sharded catalogue.
- **Curlie** supplies the large human-edited directory: roughly 2.9M entries, categories, titles and URLs.
- **GitHub Actions** rebuilds the catalogue weekly so a newly published Curlie snapshot is picked up automatically.
- **No user backend**: preferences, votes, history and recommendation weights stay in Userscripts' local GM storage.

## Discovery modes

- **For you**: broad category weights adjust after likes/dislikes, with randomness retained. Liked quick topics also get an occasional extra bias.
- **Pure random**: random root category + random catalogue shard + random fresh page.
- **Category**: choose a Curlie root category or one of the quick topic slices: space, science, technology, history, photography, nature, design, culture, games and reference.
- **Informational only**: restricts selection to non-shopping/non-business root categories.

## Dead/login/paywall reduction

The build removes obvious login/account/cart/download URLs and configured unwanted category trees. At stumble-time, optional **Smart Filter** performs a lightweight ranged request and rejects clear HTTP errors, non-HTML targets, login pages and common paywall signals before navigation. This should reduce bad hits substantially, but no crawler can guarantee that every third-party page remains alive or free forever.

## Catalogue build

```bash
python3 scripts/build_catalog.py --output _site/data
```

The builder downloads `https://curlie.org/directory-dl`, joins `*-c.tsv` website rows to `*-s.tsv` categories, deduplicates/filters URLs and writes 4,000-entry JSON shards. It intentionally omits Curlie descriptions to keep the published site below GitHub Pages' 1 GB limit.

Edit `config/catalog.json` to change blocked paths, topic slices or shard size.

## GitHub Pages

This repo is designed to deploy via `.github/workflows/deploy.yml`. In repository **Settings → Pages**, set **Source** to **GitHub Actions**. If the repository is on GitHub Free, it must be public for Pages; GitHub Pro can use a private source repository.

Expected URL: `https://bojango.github.io/stumble/`

## iPhone setup

1. Install **Userscripts** for Safari from the App Store.
2. In iPhone **Settings → Apps → Safari → Extensions → Userscripts**, enable it and allow it on all websites.
3. Open the Userscripts app once and accept/set its scripts directory if prompted.
4. In Safari, open `https://bojango.github.io/stumble/stumble.user.js`.
5. Open the Userscripts extension from Safari's extensions menu and install the script.
6. Open `https://bojango.github.io/stumble/`, choose preferences, and tap **STUMBLE**.

The script asks for all-site access because it needs to display its small control bar after Safari navigates away from the Stumble page. It does not send your likes/history anywhere.

## Data/licensing

Code: MIT.

Directory data: **Curlie.org**, licensed **CC BY 3.0**. The public page includes the required attribution. Stumble is a personal project and is not associated with the former StumbleUpon service.
