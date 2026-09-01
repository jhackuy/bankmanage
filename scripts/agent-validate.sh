#!/usr/bin/env bash
set -euo pipefail

npm ci
npm run format
npm run format:check
npm run lint
npm run typecheck
npm test
npm run migrate:check
npm run build
