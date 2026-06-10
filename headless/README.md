# Inviter Headless

## Overview

This folder contains a Puppeteer-based headless automation tool that scans Facebook posts/profiles and automatically sends invite requests to users. It uses configurable selectors to find and click invite buttons (`Pozvat`/`Invite`).

Key features preserved:

- **Invite from posts**: Scan a post URL and invite reactors
- **Profile persistence**: Reuse browser sessions via Chrome profile directory

## Quick start

1. Install dependencies

```bash
cd headless
npm ci
```

2. Run CLI

```bash
node src/index.js --url "https://www.facebook.com/..." --max 10 --delay 1000 --profile-dir ./profile
```

Options:

| Option          | Type    | Default    | Description                            |
| --------------- | ------- | ---------- | -------------------------------------- |
| `--url`         | string  | (required) | Post URL to scan                       |
| `--max`         | number  | 1000       | Max invites before stopping            |
| `--delay`       | number  | 1000       | Base delay between clicks (ms)         |
| `--profile-dir` | string  | —          | Path to Chrome profile for login reuse |
| `--headless`    | boolean | true       | Run browser in headless mode           |

3. Docker

```bash
docker build -t inviter-headless .
docker run --rm -v $(pwd)/data:/usr/src/app/data -v $(pwd)/profile:/usr/src/app/profile inviter-headless node src/index.js --url "<post-url>" --max 5 --profile-dir /usr/src/app/profile
```

Notes:

- Use a browser profile with an active login via `--profile-dir` for session reuse.
- Database file is created at `headless/data/invites.db` by default.
