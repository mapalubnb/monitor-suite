#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
read -r -s -p 'DeepSeek API Key（输入不回显）: ' flap_safe_key
printf '\n'
printf '%s' "$flap_safe_key" | node flap-monitor/configure-safe-ai-key.mjs
unset flap_safe_key
pm2 restart flap-monitor >/dev/null
printf '已仅重启 Flap。可查看 runtime-metrics.json 的 safeAi.configured / health；配置成功不等于 API 调用成功。\n'
