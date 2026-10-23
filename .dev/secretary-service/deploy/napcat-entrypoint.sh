#!/usr/bin/env bash
set -euo pipefail

cd /app
token="${NAPCAT_WS_TOKEN:?NAPCAT_WS_TOKEN is required}"
bot_id="${SECRETARY_QQ_BOT_ID:?SECRETARY_QQ_BOT_ID is required}"
config_dir=/app/napcat/config
mkdir -p "$config_dir"

if [ ! -f "$config_dir/onebot11.json" ]; then
  jq --arg url "${ONEBOT_URL:?ONEBOT_URL is required}" --arg token "$token" \
    '.network.websocketClients[0].url = $url | (.network.websocketClients[0].token) = $token' \
    /app/templates/nonebot.json > "$config_dir/onebot11.json.tmp"
  mv "$config_dir/onebot11.json.tmp" "$config_dir/onebot11.json"
fi

# NapCat may keep an account-specific copy after the first login. Keep both
# copies on the same authenticated reverse-WS configuration across restarts.
account_config="$config_dir/onebot11_${bot_id}.json"
if [ ! -f "$account_config" ]; then
  cp "$config_dir/onebot11.json" "$account_config"
fi
for file in "$config_dir"/onebot11*.json; do
  [ -f "$file" ] || continue
  tmp="$file.tmp"
  jq --arg token "$token" '(.network.websocketClients[]?.token) = $token' "$file" > "$tmp"
  mv "$tmp" "$file"
done

exec /app/entrypoint.sh "$@"
