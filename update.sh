#!/usr/bin/env bash
# ============================================================================
# vFusion update
# ============================================================================
# Brings this install up to the latest release: fetches the code, backs up
# the database, gets the new containers, and restarts the stack in the same
# shape it was already running.
#
# It exists because the manual sequence has four ways to go wrong, and three
# of them are silent:
#
#   * `docker compose up -d` without the profiles that were running quietly
#     STOPS the tunnel, the MQTT broker or the virtual camera. The stack
#     comes back looking healthy and half of it is gone.
#   * `git pull` fails on package-lock.json, every time, because the
#     frontend container rewrites it on the host at every boot.
#   * Migrations are one-way, and the moment to think about a backup is
#     before them rather than after.
#   * Nobody checks whether the thing that came back up is the new version.
#
# Usage:
#   ./update.sh                 # ask before doing anything irreversible
#   ./update.sh --yes           # don't ask
#   ./update.sh --no-backup     # skip the database dump
#   ./update.sh --check         # say what would happen, change nothing
# ============================================================================

set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ASSUME_YES=0
DO_BACKUP=1
CHECK_ONLY=0

for arg in "$@"; do
    case "$arg" in
        -y|--yes)     ASSUME_YES=1 ;;
        --no-backup)  DO_BACKUP=0 ;;
        --check|-n)   CHECK_ONLY=1 ;;
        -h|--help)    sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
    esac
done

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m !!\033[0m %s\n' "$*" >&2; exit 1; }

ask() {
    [[ $ASSUME_YES -eq 1 ]] && return 0
    local reply
    read -r -p "$1 [y/N] " reply </dev/tty || return 1
    [[ "$reply" =~ ^[Yy]$ ]]
}

command -v docker >/dev/null 2>&1 || die "docker is not in PATH."
command -v git >/dev/null 2>&1    || die "git is not in PATH."
docker compose version >/dev/null 2>&1 || die "this needs Docker Compose v2 (\`docker compose\`, not \`docker-compose\`)."

# ---------------------------------------------------------------------------
# Which stack is this — built from source, or running published images?
#
# Asking Docker rather than guessing. The image a running container was
# created from is the only answer that cannot be out of date.
# ---------------------------------------------------------------------------
COMPOSE_FILE_ARGS=()
MODE="source"
running_image="$(docker inspect --format '{{.Config.Image}}' vfusion-backend-1 2>/dev/null || true)"
if [[ "$running_image" == ghcr.io/* ]]; then
    MODE="images"
elif [[ -z "$running_image" && -f docker-compose.release.yml && ! -d backend/app ]]; then
    MODE="images"
fi
if [[ "$MODE" == "images" ]]; then
    [[ -f docker-compose.release.yml ]] || die "this install runs published images but docker-compose.release.yml is missing."
    COMPOSE_FILE_ARGS=(-f docker-compose.release.yml)
fi

dc() { docker compose "${COMPOSE_FILE_ARGS[@]}" "$@"; }

# ---------------------------------------------------------------------------
# Which profiles are up.
#
# Compose has no "the profiles I started with" memory, so a plain `up -d`
# treats every profiled service as one you did not ask for and stops it.
# Recover the set from what is actually running.
# ---------------------------------------------------------------------------
declare -A SERVICE_PROFILE=(
    [cloudflared]=cloudflared
    [caddy-quick]=quick
    [cloudflared-quick]=quick
    [mqtt-broker]=mqtt
    [mqtt-tls]=mqtt
    [rtsp-server]=rtsp
)
PROFILE_ARGS=()
ACTIVE_PROFILES=()
running_services="$(dc ps --services --status running 2>/dev/null || true)"
for svc in "${!SERVICE_PROFILE[@]}"; do
    if grep -qx "$svc" <<< "$running_services"; then
        p="${SERVICE_PROFILE[$svc]}"
        if [[ ! " ${ACTIVE_PROFILES[*]-} " == *" $p "* ]]; then
            ACTIVE_PROFILES+=("$p")
            PROFILE_ARGS+=(--profile "$p")
        fi
    fi
done

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
say "vFusion update"
echo "    directory  $(pwd)"
echo "    branch     ${BRANCH}"
echo "    mode       ${MODE} ($([[ $MODE == images ]] && echo 'pull published images' || echo 'build from source'))"
echo "    profiles   ${ACTIVE_PROFILES[*]-none}"

# ---------------------------------------------------------------------------
# What is new.
# ---------------------------------------------------------------------------
say "Fetching ${BRANCH} from origin"
git fetch --quiet --tags origin

behind="$(git rev-list --count "HEAD..origin/${BRANCH}" 2>/dev/null || echo 0)"
if [[ "$behind" -eq 0 ]]; then
    say "Already up to date with origin/${BRANCH}."
    [[ $CHECK_ONLY -eq 1 ]] && exit 0
    ask "Re-deploy the current code anyway?" || exit 0
else
    echo
    git --no-pager log --oneline --no-decorate "HEAD..origin/${BRANCH}" | head -40
    [[ "$behind" -gt 40 ]] && echo "    … and $((behind - 40)) more"
    echo
fi

if [[ $CHECK_ONLY -eq 1 ]]; then
    say "--check: nothing was changed."
    exit 0
fi

# ---------------------------------------------------------------------------
# The package-lock.json problem.
#
# The dev frontend container deletes and regenerates package-lock.json on
# every boot, and the bind mount writes it back to the host. So the working
# tree is nearly always dirty in exactly one file, and `git pull` refuses.
# Throwing away the container's copy is always right: the committed one is
# the source of truth and the container rewrites it again in thirty seconds.
# ---------------------------------------------------------------------------
if ! git diff --quiet -- frontend/package-lock.json 2>/dev/null; then
    say "Discarding the container's rewritten frontend/package-lock.json"
    git checkout -- frontend/package-lock.json
fi

if ! git diff-index --quiet HEAD --; then
    warn "You have other local changes:"
    git --no-pager status --short
    ask "Continue? The pull will stop rather than overwrite them." || exit 1
fi

# ---------------------------------------------------------------------------
# Back up before migrating. Migrations are one-way.
# ---------------------------------------------------------------------------
if [[ $DO_BACKUP -eq 1 ]]; then
    if dc ps --services --status running 2>/dev/null | grep -qx postgres; then
        mkdir -p backups
        stamp="$(date +%Y%m%d-%H%M%S)"
        dest="backups/vfusion-${stamp}.sql.gz"
        say "Backing up the database to ${dest}"
        # -T because there is no terminal here, and pg_dump's output is the
        # payload rather than something to look at.
        if dc exec -T postgres pg_dump -U verkada -d vfusion | gzip > "$dest"; then
            echo "    $(du -h "$dest" | cut -f1)"
        else
            rm -f "$dest"
            warn "The backup failed."
            ask "Continue without one? Migrations cannot be undone." || exit 1
        fi
    else
        warn "Postgres is not running, so there is nothing to back up yet."
    fi
else
    warn "Skipping the backup (--no-backup)."
fi

# ---------------------------------------------------------------------------
# Update.
# ---------------------------------------------------------------------------
if [[ "$behind" -gt 0 ]]; then
    say "Updating the working tree"
    git pull --ff-only --quiet origin "${BRANCH}"
fi

if [[ "$MODE" == "images" ]]; then
    say "Pulling published images"
    dc "${PROFILE_ARGS[@]}" pull
    say "Restarting"
    dc "${PROFILE_ARGS[@]}" up -d --remove-orphans
else
    say "Rebuilding (this is the slow path — see docs/deploying.md for the image-based one)"
    dc "${PROFILE_ARGS[@]}" up -d --build --remove-orphans
fi

# ---------------------------------------------------------------------------
# Did it come back, and is it the new one?
# ---------------------------------------------------------------------------
say "Waiting for the backend"
version=""
for _ in $(seq 1 60); do
    if body="$(curl -fsS http://localhost:18080/api/config 2>/dev/null)"; then
        version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' <<< "$body")"
        [[ -n "$version" ]] && break
    fi
    sleep 2
done

echo
if [[ -n "$version" ]]; then
    say "vFusion ${version} is up."
else
    warn "The backend did not answer within two minutes."
    echo "    docker compose ${COMPOSE_FILE_ARGS[*]-} logs -f backend"
    exit 1
fi

# Dangling images from the previous version are not deleted automatically
# and are the usual reason a host runs out of disk three releases later.
say "Old images left behind: docker image prune -f"
