# Registers the local ACP Hub server as a provider in the Copilot CLI's providers.json, with every
# model the server lists, so they show up in the CLI's model picker. Run it again to refresh the list.
# Usage: .\scripts\sync-copilot-models.ps1 [-Port 8791]
param([int]$Port = 8791)

$baseUrl = "http://127.0.0.1:$Port/v1"
$headers = @{}
if ($env:ACP_HUB_TOKEN) { $headers.Authorization = "Bearer $($env:ACP_HUB_TOKEN)" }

try {
	$ids = @((Invoke-RestMethod "$baseUrl/models" -Headers $headers -TimeoutSec 60).data.id)
} catch {
	Write-Error "Could not read $baseUrl/models. Is the server running (Run Server)? $($_.Exception.Message)"
	exit 1
}

$file = if ($env:COPILOT_PROVIDERS_CONFIG) { $env:COPILOT_PROVIDERS_CONFIG } else { Join-Path $HOME '.copilot\providers.json' }
$config = if (Test-Path $file) { Get-Content $file -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }

$provider = [ordered]@{ name = 'acp-hub'; type = 'openai'; baseUrl = $baseUrl }
if ($env:ACP_HUB_TOKEN) { $provider.bearerToken = $env:ACP_HUB_TOKEN }

# The picker id has no slash, and the wire model is the id the server knows.
$models = $ids | ForEach-Object { [ordered]@{ id = $_ -replace '/', '-'; provider = 'acp-hub'; wireModel = $_ } }

$providers = @($config.providers | Where-Object { $_ -and $_.name -ne 'acp-hub' }) + $provider
$others = @($config.models | Where-Object { $_ -and $_.provider -ne 'acp-hub' })
$config | Add-Member -NotePropertyName providers -NotePropertyValue $providers -Force
$config | Add-Member -NotePropertyName models -NotePropertyValue (@($others) + @($models)) -Force

New-Item -ItemType Directory -Force (Split-Path $file) | Out-Null
$config | ConvertTo-Json -Depth 6 | Set-Content $file -Encoding utf8
Write-Host "Wrote $($ids.Count) models to $file. Restart the CLI, then: copilot --model acp-hub/$($ids[0] -replace '/', '-')"
