#!/bin/bash
# 独立虚拟屏 :99 + 独立 dbus/无障碍总线 + 独立 HOME，不碰桌面会话
W=$HOME/wxbot
export DISPLAY=:99
export DBUS_SESSION_BUS_ADDRESS=unix:path=$W/bus
pkill -u $USER -x Xvfb; rm -f $W/bus
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp &
dbus-daemon --session --address=$DBUS_SESSION_BUS_ADDRESS --nofork &
sleep 1
/usr/libexec/at-spi-bus-launcher --launch-immediately &
sleep 1
export QT_ACCESSIBILITY=1 QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 GTK_MODULES=gail:atk-bridge NO_AT_BRIDGE=0
export HOME=$W/home LANG=zh_CN.UTF-8
exec $W/wechat/opt/wechat/wechat
