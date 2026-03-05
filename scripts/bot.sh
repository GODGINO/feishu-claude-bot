#!/bin/bash
# Feishu Claude Bot 管理脚本
# 用法: bash scripts/bot.sh [start|stop|status|restart|log]

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$PROJECT_DIR/.bot.pid"
LOG_FILE="$PROJECT_DIR/.bot.log"
export PATH="$(dirname "$(which node)"):$HOME/.local/bin:$HOME/.bun/bin:$PATH"

start() {
  if is_running; then
    echo "Bot 已在运行 (PID: $(cat "$PID_FILE"))"
    return 0
  fi
  cd "$PROJECT_DIR"
  nohup npx tsx src/index.ts >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 2
  if is_running; then
    echo "Bot 已启动 (PID: $(cat "$PID_FILE"))"
  else
    echo "Bot 启动失败，查看日志: $LOG_FILE"
    rm -f "$PID_FILE"
    return 1
  fi
}

stop() {
  if ! is_running; then
    echo "Bot 未在运行"
    rm -f "$PID_FILE"
    return 0
  fi
  local pid=$(cat "$PID_FILE")
  kill "$pid" 2>/dev/null
  sleep 2
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null
  fi
  rm -f "$PID_FILE"
  echo "Bot 已停止"
}

status() {
  if is_running; then
    echo "Bot 运行中 (PID: $(cat "$PID_FILE"))"
  else
    echo "Bot 未运行"
  fi
}

log() {
  if [ -f "$LOG_FILE" ]; then
    tail -50 "$LOG_FILE"
  else
    echo "无日志文件"
  fi
}

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

case "${1:-status}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  log)     log ;;
  *)       echo "用法: bot.sh [start|stop|restart|status|log]" ;;
esac
