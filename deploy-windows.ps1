# Windows PowerShell script to deploy IBS Manager to Raspberry Pi
# Usage: .\deploy-windows.ps1

$ErrorActionPreference = "Stop"

$PI_HOST = $env:PI_HOST
$PI_USER = $env:PI_USER
$PI_PASSWORD = $env:PI_PASSWORD

if (-not $PI_HOST -or -not $PI_USER -or -not $PI_PASSWORD) {
    Write-Host "Set PI_HOST, PI_USER, and PI_PASSWORD environment variables before running." -ForegroundColor Red
    Write-Host 'Example: $env:PI_HOST="192.168.x.x"; $env:PI_USER="ubuntu"; $env:PI_PASSWORD="your-password"' -ForegroundColor Yellow
    exit 1
}
$LOCAL_DIR = $PSScriptRoot
$REMOTE_DIR = "/tmp/flussonic-manager"

Write-Host "=== IBS Manager Deployment to Raspberry Pi ===" -ForegroundColor Green
Write-Host "Target: $PI_USER@$PI_HOST" -ForegroundColor Yellow
Write-Host ""

# Check if pscp/plink is available (PuTTY)
$pscpAvailable = Get-Command pscp -ErrorAction SilentlyContinue
$plinkAvailable = Get-Command plink -ErrorAction SilentlyContinue

if (-not $pscpAvailable -or -not $plinkAvailable) {
    Write-Host "PuTTY tools (pscp/plink) not found. Using SCP/SSH instead." -ForegroundColor Yellow
    Write-Host "If you have PuTTY installed, add it to PATH for better Windows support." -ForegroundColor Yellow
    Write-Host ""
}

# Create a temporary directory for the upload
$tempDir = Join-Path $env:TEMP "flussonic-upload"
if (Test-Path $tempDir) {
    Remove-Item -Path $tempDir -Recurse -Force
}
New-Item -ItemType Directory -Path $tempDir | Out-Null

# Copy files to temp directory (excluding node_modules, dist, .git)
Write-Host "Preparing files for upload..." -ForegroundColor Cyan
$excludePatterns = @("node_modules", "dist", ".git", "*.log", ".env")

Get-ChildItem -Path $LOCAL_DIR -Recurse | ForEach-Object {
    $relativePath = $_.FullName.Substring($LOCAL_DIR.Length + 1)
    $shouldExclude = $false
    
    foreach ($pattern in $excludePatterns) {
        if ($relativePath -like "*$pattern*") {
            $shouldExclude = $true
            break
        }
    }
    
    if (-not $shouldExclude) {
        $destPath = Join-Path $tempDir $relativePath
        $destDir = Split-Path $destPath -Parent
        
        if (-not (Test-Path $destDir)) {
            New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        }
        
        Copy-Item -Path $_.FullName -Destination $destPath -Force
    }
}

Write-Host "Files prepared. Compressing..." -ForegroundColor Cyan

# Create a zip file
$zipFile = Join-Path $env:TEMP "flussonic-manager.zip"
if (Test-Path $zipFile) {
    Remove-Item $zipFile -Force
}

Compress-Archive -Path "$tempDir\*" -DestinationPath $zipFile -Force

Write-Host "Uploading to Raspberry Pi..." -ForegroundColor Cyan

# Upload using SCP
if ($pscpAvailable) {
    & pscp -batch -pw $PI_PASSWORD $zipFile "$PI_USER@$PI_HOST`:$REMOTE_DIR.zip"
} else {
    # Use sshpass if available, otherwise prompt for password
    $sshpassAvailable = Get-Command sshpass -ErrorAction SilentlyContinue
    if ($sshpassAvailable) {
        sshpass -p $PI_PASSWORD scp $zipFile "$PI_USER@$PI_HOST:$REMOTE_DIR.zip"
    } else {
        Write-Host "Please enter your SSH password when prompted." -ForegroundColor Yellow
        scp $zipFile "$PI_USER@$PI_HOST:$REMOTE_DIR.zip"
    }
}

Write-Host "Extracting and setting up on Raspberry Pi..." -ForegroundColor Cyan

# Run setup commands on Pi
$setupCommands = @"
rm -rf $REMOTE_DIR
mkdir -p $REMOTE_DIR
unzip -o $REMOTE_DIR.zip -d $REMOTE_DIR
rm $REMOTE_DIR.zip
cd $REMOTE_DIR
chmod +x deploy-setup.sh deploy.sh
"@

if ($plinkAvailable) {
    & plink -batch -pw $PI_PASSWORD "$PI_USER@$PI_HOST" $setupCommands
} else {
    Write-Host "Please enter your SSH password when prompted." -ForegroundColor Yellow
    ssh "$PI_USER@$PI_HOST" $setupCommands
}

Write-Host ""
Write-Host "=== Upload Complete ===" -ForegroundColor Green
Write-Host "Files uploaded to $REMOTE_DIR on Raspberry Pi" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. SSH into Raspberry Pi: ssh $PI_USER@$PI_HOST" -ForegroundColor White
Write-Host "2. Run setup: cd $REMOTE_DIR && ./deploy-setup.sh" -ForegroundColor White
Write-Host "3. Deploy: sudo mv $REMOTE_DIR /opt/flussonic-manager && cd /opt/flussonic-manager && ./deploy.sh" -ForegroundColor White
Write-Host ""

# Cleanup
Remove-Item -Path $tempDir -Recurse -Force
Remove-Item -Path $zipFile -Force

Write-Host "Temporary files cleaned up." -ForegroundColor Gray
