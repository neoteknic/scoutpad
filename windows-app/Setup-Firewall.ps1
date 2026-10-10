param([string]$RobotIp = "192.168.0.142")
$ErrorActionPreference = "Stop"
$ParsedIp = $null
if (-not [System.Net.IPAddress]::TryParse($RobotIp, [ref]$ParsedIp)) { throw "IP du robot invalide" }
$Program = Join-Path $PSScriptRoot "scout-backend.exe"
if (-not (Test-Path -LiteralPath $Program)) { throw "scout-backend.exe introuvable" }
$Program = (Resolve-Path -LiteralPath $Program).Path
# Explicit program blocks override port allowances. Replace only this app's
# private TCP blocks, preserving unrelated applications and public profiles.
Get-NetFirewallApplicationFilter -Program $Program -ErrorAction SilentlyContinue | Get-NetFirewallRule | ForEach-Object {
    $Port = $_ | Get-NetFirewallPortFilter
    if ($_.Action -eq "Block" -and $Port.Protocol -eq "TCP" -and ($_.Profile.ToString() -match "Private|Any")) {
        Set-NetFirewallRule -Name $_.Name -Action Allow -Profile Private -RemoteAddress $RobotIp -EdgeTraversalPolicy Block
    }
}
$RuleName = "ScoutPad-ROS-Robot"
$Existing = Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue
if ($Existing) {
    Set-NetFirewallRule -Name $RuleName -Program $Program -Enabled True -Profile Private -Action Allow -RemoteAddress $RobotIp
} else {
    New-NetFirewallRule -Name $RuleName -DisplayName "ScoutPad ROS - robot seulement" -Direction Inbound -Program $Program -Protocol TCP -RemoteAddress $RobotIp -Action Allow -Profile Private
}
