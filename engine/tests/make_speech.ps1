# Synthesizes test speech with the built-in Windows voice. Usage: make_speech.ps1 out.wav "text to say"
param([string]$Out, [string]$Text)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Rate = 0
$s.SetOutputToWaveFile($Out)
$s.Speak($Text)
$s.Dispose()
