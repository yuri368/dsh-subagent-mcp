param(
    [Parameter(Mandatory=$true)][string]$NodePath,
    [Parameter(Mandatory=$true)][string]$Runner,
    [Parameter(Mandatory=$true)][string]$Config,
    [Parameter(Mandatory=$true)][string]$WorkingDirectory
)
$ErrorActionPreference = 'Stop'

# Quote for CreateProcess's Windows argv rules, without cmd.exe or a shell.
function ConvertTo-ServiceArgument([string]$Value) {
    $taskQuoted = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $taskQuoted = [regex]::Replace($taskQuoted, '(\\+)$', '$1$1')
    return '"' + $taskQuoted + '"'
}

try {
    $taskStart = New-Object System.Diagnostics.ProcessStartInfo
    $taskStart.FileName = $NodePath
    $taskStart.Arguments = (@($Runner, '--config', $Config, '--daemon') | ForEach-Object { ConvertTo-ServiceArgument $_ }) -join ' '
    $taskStart.WorkingDirectory = $WorkingDirectory
    $taskStart.UseShellExecute = $false
    $taskStart.CreateNoWindow = $true
    $taskStart.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $taskChild = [System.Diagnostics.Process]::Start($taskStart)
    # Keep Task Scheduler attached to the real daemon lifecycle. Exiting early
    # would lose IgnoreNew, restart-on-failure and the meaningful last result.
    $taskChild.WaitForExit()
    $taskExit = $taskChild.ExitCode
    $taskChild.Dispose()
    exit $taskExit
} catch {
    try {
        $taskLog = Join-Path ([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($Config))) 'service-launcher.log'
        [System.IO.File]::AppendAllText($taskLog, [DateTime]::UtcNow.ToString('o') + ' ' + $_.Exception.Message + [Environment]::NewLine)
    } catch { }
    exit 1
}
