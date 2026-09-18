param(
    [Parameter(Mandatory=$true)][string]$Scenes,
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [int]$Rate = 0,
    [string]$SceneId = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Speech.Synthesis;
using System.Speech.AudioFormat;
public class TutorialWord {
    public double atMs { get; set; }
    public int character { get; set; }
    public int length { get; set; }
    public string text { get; set; }
}
public static class TutorialNarration {
    public static TutorialWord[] Synthesize(string text, string destination, int rate) {
        var words = new List<TutorialWord>();
        using (var speech = new SpeechSynthesizer()) {
            speech.SelectVoice("Microsoft Zira Desktop");
            speech.Rate = rate;
            speech.Volume = 100;
            speech.SpeakProgress += (sender, e) => words.Add(new TutorialWord {
                atMs = e.AudioPosition.TotalMilliseconds,
                character = e.CharacterPosition,
                length = e.CharacterCount,
                text = e.Text
            });
            // Zira reports progress on a 16 kHz time base. Keep synthesis at
            // 16 kHz for exact event timing; FFmpeg resamples the final mix.
            speech.SetOutputToWaveFile(destination, new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
            speech.Speak(text);
            speech.SetOutputToNull();
        }
        return words.ToArray();
    }
}
'@
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$scriptScenes = Get-Content -LiteralPath $Scenes -Raw -Encoding UTF8 | ConvertFrom-Json
if ($SceneId) { $scriptScenes = @($scriptScenes | Where-Object { $_.id -eq $SceneId }) }
$records = @()
foreach ($scene in $scriptScenes) {
    if ($scene.id -notmatch '^[a-z0-9-]+$') { throw 'Invalid scene identifier.' }
    $destination = Join-Path $OutputDirectory ($scene.id + '.wav')
    $words = [TutorialNarration]::Synthesize($scene.narration, $destination, $Rate)
    if (-not $words.Length -or (Get-Item -LiteralPath $destination).Length -lt 1000) { throw "Narration failed: $($scene.id)" }
    $record = [ordered]@{ id=$scene.id; voice='Microsoft Zira Desktop'; culture='en-US'; rate=$Rate; text=$scene.narration; waveFile=($scene.id+'.wav'); words=@($words) }
    $record | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $OutputDirectory ($scene.id + '.json')) -Encoding UTF8
    $records += [pscustomobject]@{ id=$scene.id; words=$words.Length; bytes=(Get-Item -LiteralPath $destination).Length }
    Write-Output "$($scene.id): $($words.Length) spoken words"
}
$records | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'synthesis-index.json') -Encoding UTF8
