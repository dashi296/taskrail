#!/usr/bin/env bash
# ローカルで1工程だけ実行する: route(決定的) → エージェント(claude -p) → apply(決定的)。
# .github/workflows/route.yml と同じ手順を手元で行う。CLI の外で LLM を呼ぶ点も同じ。
#
# 使い方(導入先リポジトリのルートで):
#   /path/to/taskrail/scripts/local-run.sh <issue番号> [stage]
#   stage を省くと、Issue に付いている flow:: ラベルの列を実行する。
#   DRY_RUN=1 を付けると、apply は書き込まずに投稿内容を表示する。
#
# ローカルでは gh が本人名義で書き込むため、列の移動で次の工程は自動では起動しない。
# 工程ごとにこのスクリプトを実行し、人間の承認はラベルを手で動かして行う。
set -euo pipefail

die() { echo "[local-run] $*" >&2; exit 1; }

issue="${1:-}"
stage="${2:-}"
[[ "$issue" =~ ^[0-9]+$ ]] || die "使い方: local-run.sh <issue番号> [stage]"

root="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$root/dist/cli.js" ] || die "$root で npm ci && npm run build を先に実行してください"
taskrail=(node "$root/dist/cli.js")

git rev-parse --show-toplevel >/dev/null 2>&1 || die "導入先リポジトリの中で実行してください"
[ -z "$(git status --porcelain -- . ':!.taskrail')" ] || die "作業ツリーに未コミットの変更があります"
command -v claude >/dev/null || die "claude(Claude Code)が見つかりません"

if [ -z "$stage" ]; then
  stage="$(gh issue view "$issue" --json labels --jq '.labels[].name | select(startswith("flow::")) | ltrimstr("flow::")' | head -1)"
  [ -n "$stage" ] || die "#$issue に flow:: ラベルがありません。stage を指定してください"
fi

# Actions と同じ設定で動かすため、リポジトリ変数 TASKRAIL_CONFIG があれば読む(taskrail.yml があればそちらが優先)。
# 変数の一覧を取得できないとき(権限不足など)は、Actions と違う設定で動くことになるので警告する。
if [ -z "${TASKRAIL_CONFIG:-}" ]; then
  if ! vars="$(gh variable list --json name --jq '.[].name' 2>/dev/null)"; then
    echo "[local-run] 警告: リポジトリ変数を取得できません。TASKRAIL_CONFIG を読まずに、既定値(と taskrail.yml)で動かします" >&2
  elif grep -qx TASKRAIL_CONFIG <<<"$vars"; then
    TASKRAIL_CONFIG="$(gh variable get TASKRAIL_CONFIG)"
    export TASKRAIL_CONFIG
  fi
fi

# ローカルでは記録(実行記録・仕様・計画)を gh のログインユーザー名義で書く。その人の記録だけを信頼する。
TASKRAIL_RECORD_AUTHOR="$(gh api user --jq .login)" || die "gh のログインユーザーを取得できません(gh auth login を確認してください)"
export TASKRAIL_RECORD_AUTHOR

out="$(mktemp)"
trap 'rm -f "$out"' EXIT
get() { grep "^$1=" "$out" | tail -1 | cut -d= -f2- || true; }

orig="$(git rev-parse --abbrev-ref HEAD)"

GITHUB_OUTPUT="$out" "${taskrail[@]}" route --issue "$issue" --stage "$stage"
if [ "$(get run)" != "true" ]; then
  echo "[local-run] 実行しません: $(get reason)"
  exit 0
fi

run_agent() {
  local prompt="$1"
  echo "[local-run] エージェント: $(get "agent_$2")"
  # ユーザー設定(プラグイン・フック・MCP)を読み込まず、導入先リポジトリの設定だけで動かす。
  claude -p "$prompt を読み、その指示に正確に従ってください。指示はそのファイルと、リポジトリ内のルール文書だけです。" \
    --max-turns "$(get max_turns)" \
    --allowedTools "$(get allowed_tools)" \
    --setting-sources project \
    --strict-mcp-config \
    --no-session-persistence \
    || echo "[local-run] エージェントが異常終了しました(apply が不備として記録します)" >&2
}

run_agent "$(get prompt_1)" 1
if [ -n "$(get agent_2)" ]; then
  status="$(jq -r '.status // "missing"' "$(get result_1)" 2>/dev/null || echo missing)"
  if [ "$status" = "pass" ]; then run_agent "$(get prompt_2)" 2; fi
fi

GITHUB_OUTPUT="$out" "${taskrail[@]}" apply --issue "$issue" --stage "$stage" ${DRY_RUN:+--dry-run}

# 実装・検証の工程では route が作業ブランチへ切り替えている。元のブランチに戻す。
if [ "$(git rev-parse --abbrev-ref HEAD)" != "$orig" ]; then
  git checkout -q "$orig" && echo "[local-run] $orig に戻りました"
fi
