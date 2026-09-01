#!/usr/bin/env bash
set -uo pipefail

npm ci
npm run format

status=0
npm run format:check || status=1
npm run lint || status=1
npm run typecheck || status=1
npm test || status=1
npm run migrate:check || status=1
npm run build || status=1

exit "$status"
