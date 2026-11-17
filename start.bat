@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 聽書學英文：http://localhost:8001
echo 建議用 Microsoft Edge 開啟（內建翻譯 + 自然語音）。關閉這個視窗就會停止。
start "" msedge http://localhost:8001 2>nul || start "" http://localhost:8001
python -m http.server 8001 --bind 127.0.0.1
