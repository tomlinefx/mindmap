# 端末内 STT のモデルを %LOCALAPPDATA%\mindmap\models\stt に入れる（helper/README.md）。
#   - sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01（日本語、非ストリーミング。int8 の版と tokens.txt だけ残す。約 150 MB）
#   - silero_vad.onnx（VAD）
# すでにあれば何もしない。MINDMAP_STT_MODEL で置き場を変えられる
$ErrorActionPreference = "Stop"
$dir = if ($env:MINDMAP_STT_MODEL) { $env:MINDMAP_STT_MODEL } else { Join-Path $env:LOCALAPPDATA "mindmap\models\stt" }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$base = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"
$model = "sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01"

if (-not (Test-Path (Join-Path $dir "tokens.txt"))) {
  $archive = Join-Path $env:TEMP "$model.tar.bz2"
  Write-Host "$model を取得しています..."
  Invoke-WebRequest -Uri "$base/$model.tar.bz2" -OutFile $archive
  $extract = Join-Path $env:TEMP "$model-extract"
  if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
  New-Item -ItemType Directory -Force -Path $extract | Out-Null
  & tar -xjf $archive -C $extract
  if ($LASTEXITCODE -ne 0) { throw "展開に失敗しました: $archive" }
  $src = Join-Path $extract $model
  foreach ($name in @("encoder-epoch-99-avg-1.int8.onnx", "decoder-epoch-99-avg-1.int8.onnx", "joiner-epoch-99-avg-1.int8.onnx", "tokens.txt")) {
    Copy-Item (Join-Path $src $name) (Join-Path $dir $name) -Force
  }
  $wavs = Join-Path $dir "test_wavs"
  if (Test-Path (Join-Path $src "test_wavs")) { Copy-Item (Join-Path $src "test_wavs") $wavs -Recurse -Force }
  Remove-Item -Recurse -Force $extract
  Remove-Item -Force $archive
  Write-Host "モデルを置きました: $dir"
} else {
  Write-Host "モデルはあります: $dir"
}

$vad = Join-Path $dir "silero_vad.onnx"
if (-not (Test-Path $vad)) {
  Write-Host "silero_vad.onnx を取得しています..."
  Invoke-WebRequest -Uri "$base/silero_vad.onnx" -OutFile $vad
}
Write-Host "完了: $dir"
