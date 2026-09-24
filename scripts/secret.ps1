param([ValidateSet("Protect", "Unprotect")][string]$Mode)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
$value = [Console]::In.ReadToEnd()
if ($Mode -eq "Protect") {
    $bytes = [Text.Encoding]::UTF8.GetBytes($value)
    $protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Convert]::ToBase64String($protected))
}
else {
    $protected = [Convert]::FromBase64String($value)
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
}
