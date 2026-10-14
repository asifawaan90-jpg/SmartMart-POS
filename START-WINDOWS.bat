@echo off
title SmartMart POS - Starting...
cd /d "%~dp0"
set "APP_URL=http://localhost:3000"

echo [1/5] Checking Node...
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nahi mila! Pehle nodejs.org se install karo
  pause
  exit /b 1
)

node -e "const r=require('http').get(process.argv[1],x=>{x.resume();process.exit(0)});r.setTimeout(1200,()=>r.destroy());r.on('error',()=>process.exit(1))" "%APP_URL%" >nul 2>nul
if not errorlevel 1 (
  echo SmartMart pehle se chal raha hai. Browser khol raha hai...
  start "" "%APP_URL%"
  exit /b 0
)

if not exist "node_modules\next\package.json" (
  echo [2/5] Installing packages. Pehli dafa is mein kuch minutes lag sakte hain...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto setup_failed
) else (
  echo [2/5] Packages pehle se installed hain
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  if errorlevel 1 goto setup_failed
  echo [3/5] Local database ke liye .env ban gaya
) else (
  echo [3/5] .env pehle se mojood hai
)

node -e "require('@next/env').loadEnvConfig(process.cwd());const p=process.env.DB_PROVIDER;const d=process.env.DATABASE_URL||'';const s=process.env.SUPABASE_DATABASE_URL||'';let ok=false;try{const u=new URL(s);ok=(u.protocol==='postgres:'||u.protocol==='postgresql:')&&!!u.hostname&&!!u.username&&!!u.password&&!/your[_-]?(?:project[_-]?(?:id|ref)|password)|xxxxx|placeholder|example|[<>]/i.test(decodeURIComponent(u.username+' '+u.password))}catch{};if(p==='postgres'&&!ok){console.error('Cloud database configuration is incomplete. Check DB_PROVIDER and SUPABASE_DATABASE_URL in .env; use a real Supabase PostgreSQL URI, not project/password placeholders.');process.exit(1)}if(p!=='postgres'&&!d.startsWith('file:')){console.error('SQLite mode requires DATABASE_URL to start with file: (example: file:../db/custom.db). Check DB_PROVIDER and DATABASE_URL in .env.');process.exit(1)}"
if errorlevel 1 goto database_config_failed

set "FRESH_DB=0"
if not exist "db\custom.db" set "FRESH_DB=1"
if exist "prisma\dev.db" set "FRESH_DB=0"
if exist "dev.db" set "FRESH_DB=0"
if not "%FRESH_DB%"=="1" goto keep_database
findstr /b /c:"DB_PROVIDER=postgres" /c:"DB_PROVIDER = postgres" ".env" >nul 2>nul
if not errorlevel 1 goto keep_database
echo [4/5] First run: preparing the local database...
call npx prisma db push
if errorlevel 1 goto setup_failed
set "BACKUP="
for %%F in ("data-backup\*.json") do if exist "%%~F" if not defined BACKUP set "BACKUP=%%~F"
if not defined BACKUP goto no_backup
echo [5/5] Pehli dafa ka setup: included data restore ho raha hai...
call node "scripts\restore-with-env.mjs" "%BACKUP%"
if errorlevel 1 echo Restore mein masla aya. Baad mein npm run restore se dobara koshish karein.
goto database_ready

:no_backup
echo [5/5] Koi data backup nahi mila; khali database shuru hoga
goto database_ready

:keep_database
echo [4/5] Existing database found; skipping slow database setup.
echo [5/5] Existing data will be kept.

:database_ready

echo.
echo SmartMart: %APP_URL%
echo Browser app tayyar hone par khud khul jayega.
echo Band karne ke liye Ctrl + C dabayen
echo.
start "" /b node "open-when-ready.js"
call npm run dev
pause
exit /b

:setup_failed
echo.
echo Setup shuru nahi ho saka. Upar diye gaye error ko check karein.
pause
exit /b 1

:database_config_failed
echo.
echo Database configuration check failed. .env ko theek karke dobara start karein.
echo Cloud mode ke liye Supabase Dashboard se real Session Pooler URI use karein.
pause
exit /b 1