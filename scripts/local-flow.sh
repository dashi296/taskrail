#!/usr/bin/env bash
# ローカルで、人間の判断が必要な位置まで工程を連続実行する。
#   /path/to/taskrail/scripts/local-flow.sh <issue番号>
#
# 各回の「次に何をするか」は taskrail next(決定的)が決める。このスクリプトはそれに従うだけ。
#   run-stage … scripts/local-run.sh で route → エージェント → apply
#   dispatch  … ready → doing(WIP上限と依存を確認)
#   check-ci  … 実装した PR の CI の成功を待って doing → verify
#   stop      … 人間の承認待ち、blocked、完了。ここで止まる
#
# 環境変数:
#   MAX_STEPS   … 進める工程の上限(既定 20)
#   CI_TIMEOUT  … CI を待つ秒数(既定 1200)。0 で待たずに止まる
set -euo pipefail

die() { echo "[local-flow] $*" >&2; exit 1; }
say() { echo "[local-flow] $*"; }

issue="${1:-}"
[[ "$issue" =~ ^[0-9]+$ ]] || die "使い方: local-flow.sh <issue番号>"
max_steps="${MAX_STEPS:-20}"
ci_timeout="${CI_TIMEOUT:-1200}"

root="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$root/dist/cli.js" ] || die "$root で npm ci && npm run build を先に実行してください"
taskrail=(node "$root/dist/cli.js")
git rev-parse --show-toplevel >/dev/null 2>&1 || die "導入先リポジトリの中で実行してください"

# 記録は gh のログインユーザー名義。設定は Actions と同じものを使う(taskrail.yml があればそちらが優先)。
TASKRAIL_RECORD_AUTHOR="$(gh api user --jq .login)" || die "gh のログインユーザーを取得できません"
export TASKRAIL_RECORD_AUTHOR
if [ -z "${TASKRAIL_CONFIG:-}" ] && vars="$(gh variable list --json name --jq '.[].name' 2>/dev/null)" && grep -qx TASKRAIL_CONFIG <<<"$vars"; then
  TASKRAIL_CONFIG="$(gh variable get TASKRAIL_CONFIG)"
  export TASKRAIL_CONFIG
fi

out="$(mktemp)"
trap 'rm -f "$out"' EXIT
get() { grep "^$1=" "$out" | tail -1 | cut -d= -f2- || true; }
labels_of() { gh issue view "$issue" --json labels --jq '[.labels[].name] | sort | join(",")'; }

ci_waited=0
for ((step = 1; step <= max_steps; step++)); do
  : >"$out"
  GITHUB_OUTPUT="$out" "${taskrail[@]}" next --issue "$issue" >/dev/null
  action="$(get action)"
  stage="$(get stage)"
  reason="$(get reason)"

  case "$action" in
    stop)
      say "停止: $reason"
      exit 0
      ;;
    run-stage)
      say "[$step] $stage を実行します"
      ci_waited=0
      "$root/scripts/local-run.sh" "$issue" "$stage"
      ;;
    dispatch)
      say "[$step] 着手できるか判定します"
      ci_waited=0
      before="$(labels_of)"
      # 列を移した直後は GitHub の検索に反映されるまで数十秒かかる。数回試してから諦める。
      for attempt in 1 2 3; do
        "${taskrail[@]}" dispatch
        [ "$(labels_of)" = "$before" ] || break
        [ "$attempt" = 3 ] && { say "停止: 着手できません(WIP上限、依存、ai::ok の未付与のいずれか)"; exit 0; }
        say "着手されませんでした。$((attempt * 15)) 秒後にもう一度試します"
        sleep $((attempt * 15))
      done
      ;;
    check-ci)
      # dispatch は着手の判断に加えて、実装済み Issue の CI を再確認して verify へ進める。
      "${taskrail[@]}" dispatch
      if [[ ",$(labels_of)," != *",flow::$stage,"* ]]; then
        continue
      fi
      if [ "$ci_waited" -ge "$ci_timeout" ]; then
        say "停止: CI が $ci_timeout 秒以内に成功しませんでした。PR の CI を確認してください"
        exit 0
      fi
      say "[$step] CI の完了を待っています($ci_waited/$ci_timeout 秒)"
      sleep 30
      ci_waited=$((ci_waited + 30))
      step=$((step - 1)) # 待ち時間は工程数に数えない
      ;;
    *)
      die "想定しない判定です: $action ($reason)"
      ;;
  esac
done

say "停止: 工程の上限($max_steps)に達しました"
