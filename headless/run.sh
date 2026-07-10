#!/bin/bash
# Standard invocation wrapper — centralizes the env vars that must stay in
# sync with production state (e.g. rate-limit-state.json's dailyLimit),
# so ad-hoc/manual runs can't accidentally corrupt shared state by
# forgetting to pass an override. Confirmed live (2026-07-10): a manual
# discovery-backfill run that omitted DAILY_MAX_OVERRIDE silently reset
# the production daily budget from 1400 back to moderate's default 250
# (dailyLimit is re-synced from config on every run, by design — see
# rate-limiter.js's resetDailyIfNeeded()).
#
# Usage: ./run.sh [extra CLI flags]  (extra env vars can be set before the
# call, e.g. DISCOVERY_TIME_CAP_MS=7200000 ./run.sh --dry-run ...)
cd "$(dirname "$0")"
exec env \
  PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
  DAILY_MAX_OVERRIDE=1400 \
  PER_POST_MAX_OVERRIDE=420 \
  node src/index.js \
  --page "https://www.facebook.com/DanielKusPlzen" \
  --profile-dir ./profile \
  --rate-mode moderate \
  "$@"
