#!/bin/sh
# All options and subcommands belong to Codex; this launcher only adds defaults.
set -eu

codex_local_script=$(readlink -f -- "$0")
codex_local_root=$(CDPATH= cd -- "$(dirname -- "$codex_local_script")" && pwd)
codex_local_catalog=$codex_local_root/models.json
codex_local_model=codex-local

if ! command -v jq >/dev/null 2>&1; then
    printf '%s\n' 'codex-local: jq is required for model discovery.' >&2
    exit 127
fi

codex_local_file=${CODEX_LOCAL_ENDPOINTS_FILE:-${CODEX_LOCAL_MCP_ENDPOINTS_FILE:-${XDG_CONFIG_HOME:-"$HOME/.config"}/codex-local/endpoints.json}}
codex_local_primary=${CODEX_LOCAL_BASE_URL:-${CODEX_LOCAL_MCP_BASE_URL:-http://127.0.0.1:8080/v1}}
codex_local_backup=${CODEX_LOCAL_BACKUP_BASE_URL-${CODEX_LOCAL_MCP_BACKUP_BASE_URL-}}
# An explicit primary pins an MCP worker. Otherwise both entry points share the
# same user-editable file, which local_set_service can update without a restart.
if [ -z "${CODEX_LOCAL_BASE_URL-}" ] && [ -r "$codex_local_file" ]; then
    if codex_local_saved=$(jq -er '.primary | select(type == "string" and test("^https?://"))' "$codex_local_file" 2>/dev/null); then
        codex_local_primary=$codex_local_saved
        codex_local_backup=$(jq -r '.backup // empty' "$codex_local_file")
    else
        printf '%s\n' 'codex-local: invalid endpoint configuration; provide a working service address.' >&2
    fi
fi
codex_local_primary=${codex_local_primary%/}
codex_local_backup=${codex_local_backup%/}
if [ "$codex_local_backup" = "$codex_local_primary" ]; then codex_local_backup=; fi
codex_local_base_url=$codex_local_primary

# Offline help/version must not wait for a model server. Arguments stay intact.
codex_local_discover=yes
for codex_local_arg do
    case "$codex_local_arg" in
        -h|--help|-V|--version) codex_local_discover=no ;;
    esac
done

codex_local_found=no
if [ "$codex_local_discover" = yes ]; then
    for codex_local_candidate in "$codex_local_primary" "$codex_local_backup"; do
        [ -n "$codex_local_candidate" ] || continue
        if codex_local_discovered=$(curl --noproxy '*' --fail --silent \
            --connect-timeout 1 --max-time 3 \
            --url "$codex_local_candidate/models" 2>/dev/null | \
            jq -er '[.data[]? | select(.id | type == "string" and length > 0)] |
                (map(select(.status.value? == "loaded")) + .) | .[0].id |
                select(explode | all(. >= 32))' 2>/dev/null); then
            codex_local_base_url=$codex_local_candidate
            codex_local_model=$codex_local_discovered
            codex_local_found=yes
            break
        fi
    done
    if [ "$codex_local_found" = no ]; then
        printf '%s\n' 'codex-local: configured services are unavailable; provide a working IP and port.' >&2
    fi
fi

# Cache by endpoint as well as model, so an offline primary cannot inherit a
# model name learned from the backup (or a different configured service).
codex_local_digest=$(printf '%s' "$codex_local_base_url" | sha256sum)
codex_local_cache=${XDG_CACHE_HOME:-"$HOME/.cache"}/codex-local/${codex_local_digest%% *}
if [ "$codex_local_found" = no ] && [ -r "$codex_local_cache/last-model" ]; then
    IFS= read -r codex_local_model < "$codex_local_cache/last-model" || :
fi

# Include the template revision so upgrades cannot retain stale capabilities.
# Per-model files prevent concurrent launches from replacing each other's metadata.
codex_local_digest=$(sha256sum "$codex_local_catalog")
codex_local_template_key=${codex_local_digest%% *}
codex_local_effort=$(jq -er '.models[0].default_reasoning_level | select(type == "string" and length > 0)' "$codex_local_catalog")
codex_local_digest=$(printf '%s' "$codex_local_model" | sha256sum)
codex_local_key=${codex_local_digest%% *}
codex_local_cached_catalog=$codex_local_cache/models-$codex_local_key-$codex_local_template_key.json
if [ ! -r "$codex_local_cached_catalog" ]; then
    mkdir -p -- "$codex_local_cache"
    codex_local_tmp=$(mktemp "$codex_local_cache/.catalog-XXXXXX")
    jq --arg model "$codex_local_model" '.models[0].slug = $model' \
        "$codex_local_catalog" > "$codex_local_tmp"
    mv -f -- "$codex_local_tmp" "$codex_local_cached_catalog"
fi
codex_local_catalog=$codex_local_cached_catalog
if [ "$codex_local_found" = yes ]; then
    codex_local_tmp=$(mktemp "$codex_local_cache/.last-model-XXXXXX")
    printf '%s\n' "$codex_local_model" > "$codex_local_tmp"
    mv -f -- "$codex_local_tmp" "$codex_local_cache/last-model"
fi
codex_local_model_toml=$(jq -nr --arg model "$codex_local_model" '$model | tojson')
codex_local_catalog_toml=$(jq -nr --arg path "$codex_local_catalog" '$path | tojson')
codex_local_url_toml=$(jq -nr --arg url "$codex_local_base_url" '$url | tojson')
codex_local_effort_toml=$(jq -nr --arg effort "$codex_local_effort" '$effort | tojson')
codex_local_authority=${codex_local_base_url#*://}
codex_local_authority=${codex_local_authority%%/*}
case "$codex_local_authority" in
    "["*) codex_local_host=${codex_local_authority#"["}; codex_local_host=${codex_local_host%%"]"*} ;;
    *) codex_local_host=${codex_local_authority%%:*} ;;
esac

# Inference stays on the LAN even when the invoking shell has a proxy configured.
NO_PROXY="${NO_PROXY:+$NO_PROXY,}$codex_local_host"
no_proxy="${no_proxy:+$no_proxy,}$codex_local_host"
export NO_PROXY no_proxy

exec codex \
    -c 'model_provider="lan_local"' \
    -c "model=$codex_local_model_toml" \
    -c "model_catalog_json=$codex_local_catalog_toml" \
    -c "model_reasoning_effort=$codex_local_effort_toml" \
    -c 'model_reasoning_summary="none"' \
    -c 'web_search="disabled"' \
    -c "model_providers.lan_local={name=\"LAN local model\",base_url=$codex_local_url_toml,wire_api=\"responses\",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0,stream_idle_timeout_ms=60000}" \
    "$@"
