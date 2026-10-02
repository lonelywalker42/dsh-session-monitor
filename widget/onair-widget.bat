@echo off
rem onair-widget.bat — DSH 会话监控桌面件启动器（原生 onair-widget.exe，无需 powershell）
rem 依赖：dsh 后台运行 + 主机侧监控插件（http://127.0.0.1:8091）
rem 开机自启：把本文件的快捷方式放入 shell:startup 即可

set "WIDGET_DIR=%~dp0"
set "PORT=8091"
if not "%1"=="" set "PORT=%1"

start "" "%WIDGET_DIR%onair-widget.exe" %PORT%