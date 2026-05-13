param(
  [Parameter(Mandatory = $true)]
  [string]$Message
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $Root
try {
  & (Join-Path $PSScriptRoot "bootstrap-dvc.ps1")
  $Python = Join-Path $Root ".tools\Python311\python.exe"
  & $Python -m dvc add "public/resources/runtime" "resources/editor_projects" "resources/vendor_archives"
  git add .dvc .dvcignore .gitignore public/resources resources src tools scripts config package.json package-lock.json tsconfig.json vite.config.ts README.md
  git add -u
  git commit -m $Message
}
finally {
  Pop-Location
}
