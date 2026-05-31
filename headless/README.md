# Inviter Headless

This folder contains a minimal headless Node.js service (Puppeteer) that ports the extension's invite/follow automation to a server environment.

Quick start (local):

1. Install dependencies

```bash
cd headless
npm ci
```

2. Run CLI (example)

```bash
node src/index.js --url "https://www.facebook.com/..." --max 10 --delay 1000 --profile-dir ./profile
```

To click invite buttons only on the list, use:

```bash
node src/index.js --url "https://www.facebook.com/..." --profile-dir ./profile --invite-follow --headless=false
```

To do a no-click test run that scans and saves matching accounts without inviting, use:

```bash
node src/index.js --url "https://www.facebook.com/..." --profile-dir ./profile --dry-run --headless=false
```

3. Docker (build + run)

```bash
docker build -t inviter-headless .
docker run --rm -v $(pwd)/data:/usr/src/app/data -v $(pwd)/profile:/usr/src/app/profile inviter-headless node src/index.js --url "<post-url>" --max 5 --profile-dir /usr/src/app/profile
```

Notes:

- The service expects a browser profile with an active login if you use `--profile-dir` (recommended for MVP).
- Database file is created at `headless/data/invites.db` by default.
