$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $workspace 'compose.yaml'

function Invoke-Compose {
    param([string[]]$Arguments)
    & docker compose -f $composeFile @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose failed with exit code $LASTEXITCODE"
    }
}

Invoke-Compose @('up', '-d', '--build', 'postgres', 'redis', 'event-worker', 'flight-worker')
Invoke-Compose @('--profile', 'fixture', 'run', '--build', '--rm', 'fixture-publisher')

$deadline = (Get-Date).AddSeconds(45)
do {
    $count = & docker compose -f $composeFile exec -T postgres psql -U travel -d travel -Atc `
        "SELECT count(*) FROM alerts WHERE source = 'fixture' AND status = 'pending' AND suggested_change->>'type' = 'replan';"
    if ($LASTEXITCODE -ne 0) {
        throw "Could not query pending fixture suggestions (docker compose exit code $LASTEXITCODE)"
    }
    if ([int]$count -gt 0) {
        Write-Output 'Flight delay fixture produced a pending re-planning suggestion.'
        exit 0
    }
    Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)

throw 'Timed out waiting for the fixture event to be recorded. Inspect logs with: docker compose -f compose.yaml logs flight-worker event-worker'
