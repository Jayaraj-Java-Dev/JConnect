#!/bin/bash

echo "🌟 Welcome! Starting the build process..."

# Check if pkg is available
if ! command -v pkg &> /dev/null; then
  echo "❌ 'pkg' command not found. Please install it first (npm install -g pkg)."
  exit 1
fi

# Build function
build_file() {
  local input="$1"
  local output="$2"
  echo "🔧 Building $input → $output ..."
  if pkg "$input" --output "$output"; then
    echo "✅ Successfully built $output"
  else
    echo "❌ Failed to build $output"
  fi
}

# Main logic
if [ $# -eq 0 ]; then
  echo "ℹ️ No arguments provided, building both 'jserv' and 'jcli'"
  build_file jserv.js jserv
  build_file jcli.js jcli
else
  for arg in "$@"; do
    case "$arg" in
      jserv)
        build_file jserv.js jserv
        ;;
      jcli)
        build_file jcli.js jcli
        ;;
      *)
        echo "⚠️ Unknown target: $arg. Valid options are: jserv, jcli"
        ;;
    esac
  done
fi

echo "🎉 Build process completed. Have a great day!"
