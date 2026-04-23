@echo off
REM D&D Bot Setup for Windows Docker Desktop
REM This script sets up and runs the D&D Bot

setlocal enabledelayedexpansion

echo.
echo ============================================================
echo   D^&D Discord Bot - Windows Setup
echo ============================================================
echo.

REM Check if Docker is installed
docker --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Docker Desktop is not installed or not in PATH
    echo Please install Docker Desktop from: https://www.docker.com/products/docker-desktop
    pause
    exit /b 1
)

echo ^✓ Docker found: 
docker --version
echo.

REM Check if Docker daemon is running
docker ps >nul 2>&1
if errorlevel 1 (
    echo ERROR: Docker daemon is not running
    echo Please start Docker Desktop and try again
    pause
    exit /b 1
)

echo ^✓ Docker Desktop is running
echo.

REM Create directories if they don't exist
if not exist "worlds" mkdir worlds
if not exist "ambient_sounds" mkdir ambient_sounds
echo ^✓ Directories created/verified
echo.

REM Check if .env exists
if not exist ".env" (
    echo Creating .env file...
    echo.
    
    REM Create .env with prompts
    (
        echo REM D^&D Bot Configuration
        echo REM Fill in your API keys below
        echo.
        echo DISCORD_TOKEN=
        echo OPENAI_API_KEY=
        echo OPENAI_MODEL=gpt-4o-mini
        echo ELEVENLABS_API_KEY=
        echo ELEVENLABS_VOICE_ID=
        echo LLM_PROVIDER=openai
        echo WORLD_FILE=ashmore_keep.txt
    ) > .env
    
    echo.
    echo ^✓ Created .env file
    echo.
    echo IMPORTANT: Edit .env and fill in your API keys:
    echo   - DISCORD_TOKEN (from Discord Developer Portal)
    echo   - OPENAI_API_KEY (from OpenAI Platform)
    echo   - ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID (from ElevenLabs)
    echo.
    echo Then re-run this script.
    echo.
    pause
    exit /b 0
) else (
    echo ^✓ .env file found
    
    REM Check if API keys are filled in
    for /f "tokens=2 delims==" %%A in ('findstr "DISCORD_TOKEN" .env') do set DISCORD_TOKEN=%%A
    
    if "!DISCORD_TOKEN!"=="" (
        echo.
        echo WARNING: DISCORD_TOKEN not set in .env
        echo Please fill in your API keys before continuing
        pause
        exit /b 1
    )
)

echo.
echo ============================================================
echo   Loading Docker Image
echo ============================================================
echo.

REM Check if docker image tar file exists
if exist "d-d-bot-v0.1.0-beta.tar" (
    echo Found Docker image tar file, importing...
    docker load -i d-d-bot-v0.1.0-beta.tar
    if errorlevel 1 (
        echo ERROR: Failed to load Docker image
        pause
        exit /b 1
    )
    echo ^✓ Docker image loaded
) else (
    echo Checking if image is already loaded...
    docker images | findstr "d-d-bot-bot" >nul 2>&1
    if errorlevel 1 (
        echo ERROR: Docker image not found
        echo Please ensure d-d-bot-v0.1.0-beta.tar is in this directory
        pause
        exit /b 1
    )
    echo ^✓ Docker image already loaded
)

echo.
echo ============================================================
echo   Starting D^&D Bot
echo ============================================================
echo.

REM Start the bot with docker-compose
docker compose up -d

if errorlevel 1 (
    echo ERROR: Failed to start bot
    pause
    exit /b 1
)

echo.
echo ^✓ Bot is starting...
echo.
echo Waiting for bot to initialize (30 seconds)...
timeout /t 30 /nobreak

echo.
echo ============================================================
echo   Setup Complete!
echo ============================================================
echo.
echo Your D^&D Bot is now running in Docker Desktop.
echo.
echo NEXT STEPS:
echo 1. Open Discord and find your server
echo 2. In Discord, use /help to see all commands
echo 3. Start with /join to begin!
echo.
echo To stop the bot, run:
echo   docker compose down
echo.
echo To view logs:
echo   docker compose logs -f
echo.
echo For more info, see README.md
echo.
pause
