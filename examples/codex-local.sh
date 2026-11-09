#!/bin/sh
# All options and subcommands belong to Codex; this launcher only adds defaults.
set -eu

codex_local_script=$(readlink -f -- "$0")
codex_local_root=$(CDPATH= cd -- "$(dirname -- "$codex_local_script")" && pwd)
codex_local_catalog=$codex_local_root/models.json
codex_local_base_url=${CODEX_LOCAL_BASE_URL:-${CODEX_LOCAL_MCP_BASE_URL:-http://127.0.0.1:8080/v1}}
codex_local_base_url=${codex_local_base_url%/}
codex_local_authority=${codex_local_base_url#*://}
codex_local_authority=${codex_local_authority%%/*}
case "$codex_local_authority" in
    "["*) codex_local_host=${codex_local_authority#"["}; codex_local_host=${codex_local_host%%"]"*} ;;
    *) codex_local_host=${codex_local_authority%%:*} ;;
esac
codex_local_url_toml=$(jq -nr --arg url "$codex_local_base_url" '$url | tojson')
codex_local_model=codex-local
codex_local_cache=${XDG_CACHE_HOME:-"$HOME/.cache"}/codex-local

if ! command -v jq >/dev/null 2>&1; then
    printf '%s\n' 'codex-local: jq is required for model discovery.' >&2
    exit 127
fi

# Offline help/version must not wait for a model server. Arguments stay intact.
codex_local_discover=yes
for codex_local_arg do
    case "$codex_local_arg" in
        -h|--help|-V|--version) codex_local_discover=no ;;
    esac
done

if [ -r "$codex_local_cache/last-model" ]; then
    IFS= read -r codex_local_model < "$codex_local_cache/last-model" || :
fi

if [ "$codex_local_discover" = yes ]; then
    if codex_local_discovered=$(curl --noproxy '*' --fail --silent \
        --connect-timeout 1 --max-time 3 \
        --url "$codex_local_base_url/models" 2>/dev/null | \
        jq -er '[.data[]? | select(.id | type == "string" and length > 0)] |
            (map(select(.status.value? == "loaded")) + .) | .[0].id |
            select(explode | all(. >= 32))' 2>/dev/null); then
        codex_local_model=$codex_local_discovered
    fi
fi

# A per-ID catalog prevents two concurrent launches from replacing each other's
# metadata while a different backend is being loaded at the shared endpoint.
codex_local_digest=$(printf '%s' "$codex_local_model" | sha256sum)
codex_local_key=${codex_local_digest%% *}
codex_local_cached_catalog=$codex_local_cache/models-$codex_local_key.json
if [ ! -r "$codex_local_cached_catalog" ]; then
    mkdir -p -- "$codex_local_cache"
    codex_local_tmp=$(mktemp "$codex_local_cache/.catalog-XXXXXX")
    jq --arg model "$codex_local_model" '.models[0].slug = $model' \
        "$codex_local_catalog" > "$codex_local_tmp"
    mv -f -- "$codex_local_tmp" "$codex_local_cached_catalog"
fi
codex_local_catalog=$codex_local_cached_catalog
if [ "$codex_local_discover" = yes ]; then
    codex_local_tmp=$(mktemp "$codex_local_cache/.last-model-XXXXXX")
    printf '%s\n' "$codex_local_model" > "$codex_local_tmp"
    mv -f -- "$codex_local_tmp" "$codex_local_cache/last-model"
fi
codex_local_model_toml=$(jq -nr --arg model "$codex_local_model" '$model | tojson')
codex_local_catalog_toml=$(jq -nr --arg path "$codex_local_catalog" '$path | tojson')

# Inference stays on the LAN even when the invoking shell has a proxy configured.
NO_PROXY="${NO_PROXY:+$NO_PROXY,}$codex_local_host"
no_proxy="${no_proxy:+$no_proxy,}$codex_local_host"
export NO_PROXY no_proxy

exec codex \
    -c 'model_provider="lan_local"' \
    -c "model=$codex_local_model_toml" \
    -c "model_catalog_json=$codex_local_catalog_toml" \
    -c 'model_reasoning_effort="low"' \
    -c 'web_search="disabled"' \
    -c "model_providers.lan_local={name=\"LAN local model\",base_url=$codex_local_url_toml,wire_api=\"responses\",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0,stream_idle_timeout_ms=60000}" \
    "$@"
