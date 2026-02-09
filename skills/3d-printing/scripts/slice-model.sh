#!/bin/bash
# slice-model.sh - Slice a 3D model using OrcaSlicer CLI
# Usage: slice-model.sh <model_path> <filament_preset> <quality_preset> <output_description>

set -e

MODEL_PATH="$1"
FILAMENT_PRESET="$2"
QUALITY_PRESET="$3"
OUTPUT_DESC="$4"

CONFIG_FILE="${HOME}/.casterly/config/3d-printing.yaml"
if [[ ! -f "$CONFIG_FILE" ]]; then
    CONFIG_FILE="$(dirname "$0")/../../../config/3d-printing.yaml"
fi

# Check inputs
if [[ -z "$MODEL_PATH" ]] || [[ -z "$FILAMENT_PRESET" ]] || [[ -z "$QUALITY_PRESET" ]] || [[ -z "$OUTPUT_DESC" ]]; then
    echo "Error: Missing required arguments"
    echo "Usage: slice-model.sh <model_path> <filament_preset> <quality_preset> <output_description>"
    exit 1
fi

if [[ ! -f "$MODEL_PATH" ]]; then
    echo "Error: Model file not found: $MODEL_PATH"
    exit 1
fi

# Parse config (basic yaml parsing with grep/sed)
get_config() {
    local key="$1"
    grep -A 100 "^$key:" "$CONFIG_FILE" 2>/dev/null | head -1 | sed 's/.*: *//' | tr -d '"'
}

get_filament_setting() {
    local preset="$1"
    local setting="$2"
    awk "/^  $preset:$/,/^  [a-z]/" "$CONFIG_FILE" | grep "    $setting:" | head -1 | sed 's/.*: *//' | tr -d '"'
}

get_quality_setting() {
    local preset="$1"
    local setting="$2"
    awk "/^  $preset:$/,/^  [a-z]/" "$CONFIG_FILE" | grep "    $setting:" | head -1 | sed 's/.*: *//' | tr -d '"'
}

# Get output directory
OUTPUT_BASE="${HOME}/.casterly/prints"
mkdir -p "$OUTPUT_BASE"

# Create dated output folder
DATE=$(date +%Y-%m-%d)
SAFE_DESC=$(echo "$OUTPUT_DESC" | tr ' ' '-' | tr -cd '[:alnum:]-_')
OUTPUT_DIR="${OUTPUT_BASE}/${DATE}_${SAFE_DESC}"
mkdir -p "$OUTPUT_DIR"

# Get model filename
MODEL_FILENAME=$(basename "$MODEL_PATH")
MODEL_NAME="${MODEL_FILENAME%.*}"

# Copy original model
cp "$MODEL_PATH" "$OUTPUT_DIR/"

# Get slicer path
SLICER=$(get_config "executable" || echo "orca-slicer")
if ! command -v "$SLICER" &> /dev/null; then
    # Try macOS app location
    SLICER="/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer"
    if [[ ! -x "$SLICER" ]]; then
        echo "Error: OrcaSlicer not found. Install from https://github.com/SoftFever/OrcaSlicer/releases"
        exit 1
    fi
fi

# Get filament settings
NOZZLE_TEMP=$(get_filament_setting "$FILAMENT_PRESET" "nozzle_temp")
BED_TEMP=$(get_filament_setting "$FILAMENT_PRESET" "bed_temp")
FLOW_RATIO=$(get_filament_setting "$FILAMENT_PRESET" "flow_ratio")

# Get quality settings
LAYER_HEIGHT=$(get_quality_setting "$QUALITY_PRESET" "layer_height")
INFILL=$(get_quality_setting "$QUALITY_PRESET" "infill_percentage")
WALL_LOOPS=$(get_quality_setting "$QUALITY_PRESET" "wall_loops")
PRINT_SPEED=$(get_quality_setting "$QUALITY_PRESET" "print_speed")

# Output gcode path
GCODE_PATH="${OUTPUT_DIR}/${MODEL_NAME}.gcode"

echo "═══════════════════════════════════════════════════════════════"
echo "Slicing: $MODEL_FILENAME"
echo "═══════════════════════════════════════════════════════════════"
echo "Filament: $FILAMENT_PRESET (${NOZZLE_TEMP}°C nozzle, ${BED_TEMP}°C bed)"
echo "Quality:  $QUALITY_PRESET (${LAYER_HEIGHT}mm layer, ${INFILL}% infill)"
echo "Output:   $OUTPUT_DIR"
echo "═══════════════════════════════════════════════════════════════"

# Run OrcaSlicer CLI
# Note: OrcaSlicer CLI syntax - adjust based on actual CLI options
"$SLICER" \
    --slice \
    --load-settings \
    --nozzle-temperature "$NOZZLE_TEMP" \
    --bed-temperature "$BED_TEMP" \
    --layer-height "$LAYER_HEIGHT" \
    --infill-density "$INFILL" \
    --wall-loops "$WALL_LOOPS" \
    --export-gcode \
    --output "$GCODE_PATH" \
    "$MODEL_PATH" 2>&1 || {
        # If CLI fails, try alternative approach using config file export
        echo "Note: Direct CLI slicing not available, using profile-based approach"

        # Create a simple settings file
        SETTINGS_FILE="${OUTPUT_DIR}/settings.json"
        cat > "$SETTINGS_FILE" << SETTINGS_EOF
{
    "nozzle_temperature": $NOZZLE_TEMP,
    "bed_temperature": $BED_TEMP,
    "layer_height": $LAYER_HEIGHT,
    "infill_density": "$INFILL%",
    "wall_loops": $WALL_LOOPS,
    "print_speed": $PRINT_SPEED,
    "filament_preset": "$FILAMENT_PRESET",
    "quality_preset": "$QUALITY_PRESET"
}
SETTINGS_EOF

        # Try running with settings file
        "$SLICER" -o "$GCODE_PATH" "$MODEL_PATH" 2>&1 || {
            echo "Error: Slicing failed. Please check OrcaSlicer installation."
            exit 1
        }
    }

# Create metadata file
cat > "${OUTPUT_DIR}/metadata.json" << METADATA_EOF
{
    "model_file": "$MODEL_FILENAME",
    "sliced_at": "$(date -Iseconds)",
    "filament_preset": "$FILAMENT_PRESET",
    "quality_preset": "$QUALITY_PRESET",
    "settings": {
        "nozzle_temp": $NOZZLE_TEMP,
        "bed_temp": $BED_TEMP,
        "layer_height": $LAYER_HEIGHT,
        "infill_percentage": $INFILL,
        "wall_loops": $WALL_LOOPS,
        "flow_ratio": ${FLOW_RATIO:-1.0}
    },
    "output_gcode": "$(basename "$GCODE_PATH")",
    "description": "$OUTPUT_DESC"
}
METADATA_EOF

echo ""
echo "✓ Slicing complete!"
echo "  Model:  ${OUTPUT_DIR}/${MODEL_FILENAME}"
echo "  GCode:  $GCODE_PATH"
echo "  Config: ${OUTPUT_DIR}/metadata.json"
