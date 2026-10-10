$ErrorActionPreference = "Stop"
$RuleName = "ScoutPad-ROS-TCPROS"
$Existing = Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue
if ($Existing) {
    Set-NetFirewallRule -Name $RuleName -Enabled True -Profile Private -Action Allow
} else {
    New-NetFirewallRule -Name $RuleName -DisplayName "ScoutPad ROS TCPROS 18112" -Direction Inbound -LocalPort 18112 -Protocol TCP -Action Allow -Profile Private
}
