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

3. Docker (build + run)

```bash
docker build -t inviter-headless .
docker run --rm -v $(pwd)/data:/usr/src/app/data -v $(pwd)/profile:/usr/src/app/profile inviter-headless node src/index.js --url "<post-url>" --max 5 --profile-dir /usr/src/app/profile
```

Notes:

- The service expects a browser profile with an active login if you use `--profile-dir` (recommended for MVP).
- Database file is created at `headless/data/invites.db` by default.
