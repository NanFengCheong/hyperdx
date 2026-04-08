#!/bin/bash
# Generate favicon assets from favicon.png for both themes
# Uses macOS sips (Scriptable Image Processing System)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBLIC_DIR="$SCRIPT_DIR/public"
SOURCE="$PUBLIC_DIR/favicon.png"

if [ ! -f "$SOURCE" ]; then
  echo "Error: $SOURCE not found"
  exit 1
fi

HYPERDX_DIR="$PUBLIC_DIR/favicons/hyperdx"
CLICKSTACK_DIR="$PUBLIC_DIR/favicons/clickstack"

mkdir -p "$HYPERDX_DIR" "$CLICKSTACK_DIR"

# Function to resize PNG using sips
resize_png() {
  local src="$1"
  local dst="$2"
  local size="$3"
  sips -Z "$size" "$src" --out "$dst" >/dev/null 2>&1
  echo "  Generated: $dst"
}

echo "Generating HyperDX favicons..."
resize_png "$SOURCE" "$HYPERDX_DIR/favicon-32x32.png" 32
resize_png "$SOURCE" "$HYPERDX_DIR/favicon-16x16.png" 16
resize_png "$SOURCE" "$HYPERDX_DIR/apple-touch-icon.png" 180

echo "Generating ClickStack favicons..."
resize_png "$SOURCE" "$CLICKSTACK_DIR/favicon-32x32.png" 32
resize_png "$SOURCE" "$CLICKSTACK_DIR/favicon-16x16.png" 16
resize_png "$SOURCE" "$CLICKSTACK_DIR/apple-touch-icon.png" 180

# Generate SVG favicon from the PNG
# Embed as base64 data URI inside an SVG wrapper
PNG_BASE64=$(base64 -i "$SOURCE" | tr -d '\n')

SVG_CONTENT="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"100\" height=\"100\" viewBox=\"0 0 100 100\">
  <image width=\"100\" height=\"100\" xlink:href=\"data:image/png;base64,$PNG_BASE64\" />
</svg>"

echo "$SVG_CONTENT" > "$HYPERDX_DIR/favicon.svg"
echo "  Generated: $HYPERDX_DIR/favicon.svg"

cp "$HYPERDX_DIR/favicon.svg" "$CLICKSTACK_DIR/favicon.svg"
echo "  Generated: $CLICKSTACK_DIR/favicon.svg"

echo ""
echo "Done! Favicon assets generated for both themes."
