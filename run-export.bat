@echo off
cd /d "%~dp0"
if not exist logs mkdir logs
npm run export-batch >> logs\export-batch.log 2>&1
