#!/bin/bash
# 接到 start.sh 起的虚拟屏和无障碍总线上跑：./run.sh watch | dump | shot a.png | ask 问题
cd "$(dirname "$0")"
export DISPLAY=:99 DBUS_SESSION_BUS_ADDRESS=unix:path=$HOME/wxbot/bus
exec node src/main.ts "${@:-watch}"
