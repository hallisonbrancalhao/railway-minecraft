#!/usr/bin/env bash
set -euo pipefail

export CREATE_CONSOLE_IN_PIPE="${CREATE_CONSOLE_IN_PIPE:-true}"

app_entry="${APP_ENTRY:-/app/server}"
run_uid="${UID:-1000}"
run_gid="${GID:-1000}"

/start &
mc_pid=$!

if command -v gosu >/dev/null 2>&1; then
  gosu "${run_uid}:${run_gid}" "${app_entry}" &
else
  "${app_entry}" &
fi
app_pid=$!

shutdown() {
  kill -TERM "${mc_pid}" "${app_pid}" 2>/dev/null || true
  wait "${mc_pid}" "${app_pid}" 2>/dev/null || true
}

trap shutdown SIGTERM SIGINT

wait -n "${mc_pid}" "${app_pid}"
exit_code=$?
shutdown
exit "${exit_code}"
