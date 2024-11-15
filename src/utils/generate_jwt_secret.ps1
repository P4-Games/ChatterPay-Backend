# Generate a secure random string of 64 characters for JWT_SECRET
$jwtSecret = -join ((65..90) + (97..122) + (48..57) + (33,35,36,37,38,42,64) | Get-Random -Count 64 | % {[char]$_})

# Create or update .env file
if (Test-Path .env) {
    # Remove existing JWT variables if they exist
    (Get-Content .env) | Where-Object { $_ -notmatch '^JWT_' } | Set-Content .env
}

# Append new JWT variables
@"
JWT_SECRET=$jwtSecret
JWT_EXPIRY=24h
"@ | Add-Content .env

Write-Host "JWT secret has been generated and stored in .env file"
Write-Host "JWT expiry set to 24h"