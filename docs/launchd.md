# 开机自启（macOS launchd）

把下面的内容存为 `~/Library/LaunchAgents/com.sofia.daemon.plist`，把两处路径换成你机器上的实际值（`which node` 与仓库位置）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.sofia.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/你/Sofia/packages/daemon/src/cli.ts</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>/tmp/sofia.log</string>
  <key>StandardErrorPath</key><string>/tmp/sofia.log</string>
</dict>
</plist>
```

```
launchctl load ~/Library/LaunchAgents/com.sofia.daemon.plist     # 启用并立即启动
launchctl unload ~/Library/LaunchAgents/com.sofia.daemon.plist   # 停用
```

- 需要 Node ≥ 24。数据目录默认 `~/.sofia/`；要换目录就在 plist 里加 `EnvironmentVariables` → `SOFIA_HOME`。
- `sofia start` 自带监督重启（管理页的"重启"靠它）；launchd 只负责开机拉起和异常退出后重拉。
- 不要加 `--terminal`：没有终端时它读不到输入。
- 单实例锁会拒绝第二个 daemon：已经用 launchd 跑着正式实例时，手动测试用 `SOFIA_HOME=~/.sofia-dev`。
