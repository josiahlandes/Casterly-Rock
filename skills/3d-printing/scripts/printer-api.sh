#!/bin/bash
# printer-api.sh - Interact with the 3D printer via its network API
# Supports Moonraker (Klipper), OctoPrint, and Elegoo native APIs
# Usage: printer-api.sh <command> [args...]

set -e

COMMAND="$1"
shift || true

CONFIG_FILE="${HOME}/.casterly/config/3d-printing.yaml"
if [[ ! -f "$CONFIG_FILE" ]]; then
    CONFIG_FILE="$(dirname "$0")/../../../config/3d-printing.yaml"
fi

# Parse printer config
get_printer_config() {
    local key="$1"
    awk '/^printer:/,/^[a-z]/' "$CONFIG_FILE" | grep "  $key:" | head -1 | sed 's/.*: *//' | tr -d '"'
}

PRINTER_ADDRESS=$(get_printer_config "address")
PRINTER_PORT=$(get_printer_config "port")
API_TYPE=$(get_printer_config "api_type")
API_KEY=$(get_printer_config "api_key")

BASE_URL="http://${PRINTER_ADDRESS}:${PRINTER_PORT}"

# HTTP request helper
api_request() {
    local method="$1"
    local endpoint="$2"
    local data="$3"

    local headers=()
    headers+=("-H" "Content-Type: application/json")

    if [[ -n "$API_KEY" ]]; then
        case "$API_TYPE" in
            moonraker)
                headers+=("-H" "X-Api-Key: $API_KEY")
                ;;
            octoprint)
                headers+=("-H" "X-Api-Key: $API_KEY")
                ;;
        esac
    fi

    if [[ "$method" == "POST" ]] && [[ -n "$data" ]]; then
        curl -s -X POST "${headers[@]}" -d "$data" "${BASE_URL}${endpoint}"
    elif [[ "$method" == "POST" ]]; then
        curl -s -X POST "${headers[@]}" "${BASE_URL}${endpoint}"
    else
        curl -s "${headers[@]}" "${BASE_URL}${endpoint}"
    fi
}

# Upload file (multipart form)
upload_file() {
    local filepath="$1"
    local filename="$2"

    local headers=()
    if [[ -n "$API_KEY" ]]; then
        headers+=("-H" "X-Api-Key: $API_KEY")
    fi

    case "$API_TYPE" in
        moonraker)
            curl -s "${headers[@]}" \
                -F "file=@${filepath};filename=${filename}" \
                "${BASE_URL}/server/files/upload"
            ;;
        octoprint)
            curl -s "${headers[@]}" \
                -F "file=@${filepath};filename=${filename}" \
                "${BASE_URL}/api/files/local"
            ;;
        elegoo)
            # Elegoo-specific upload endpoint
            curl -s "${headers[@]}" \
                -F "file=@${filepath};filename=${filename}" \
                "${BASE_URL}/upload"
            ;;
    esac
}

# ═══════════════════════════════════════════════════════════════════════════════
# Commands
# ═══════════════════════════════════════════════════════════════════════════════

case "$COMMAND" in
    # ───────────────────────────────────────────────────────────────────────────
    # Get printer info and connection status
    # ───────────────────────────────────────────────────────────────────────────
    info)
        echo "Checking printer connection..."
        case "$API_TYPE" in
            moonraker)
                INFO=$(api_request GET "/printer/info")
                STATE=$(echo "$INFO" | jq -r '.result.state // "unknown"')
                HOSTNAME=$(echo "$INFO" | jq -r '.result.hostname // "unknown"')

                echo "═══════════════════════════════════════════════════════════"
                echo "Printer: $(get_printer_config 'name')"
                echo "Address: ${PRINTER_ADDRESS}:${PRINTER_PORT}"
                echo "API:     $API_TYPE"
                echo "State:   $STATE"
                echo "Host:    $HOSTNAME"
                echo "═══════════════════════════════════════════════════════════"
                ;;
            octoprint)
                INFO=$(api_request GET "/api/connection")
                STATE=$(echo "$INFO" | jq -r '.current.state // "unknown"')

                echo "═══════════════════════════════════════════════════════════"
                echo "Printer: $(get_printer_config 'name')"
                echo "Address: ${PRINTER_ADDRESS}:${PRINTER_PORT}"
                echo "API:     $API_TYPE"
                echo "State:   $STATE"
                echo "═══════════════════════════════════════════════════════════"
                ;;
            elegoo|*)
                # Generic connection test
                if curl -s --connect-timeout 5 "${BASE_URL}" > /dev/null 2>&1; then
                    echo "═══════════════════════════════════════════════════════════"
                    echo "Printer: $(get_printer_config 'name')"
                    echo "Address: ${PRINTER_ADDRESS}:${PRINTER_PORT}"
                    echo "API:     $API_TYPE"
                    echo "Status:  Connected"
                    echo "═══════════════════════════════════════════════════════════"
                else
                    echo "Error: Cannot connect to printer at ${BASE_URL}"
                    exit 1
                fi
                ;;
        esac
        ;;

    # ───────────────────────────────────────────────────────────────────────────
    # Get current print status
    # ───────────────────────────────────────────────────────────────────────────
    status)
        case "$API_TYPE" in
            moonraker)
                STATUS=$(api_request GET "/printer/objects/query?print_stats&display_status&heater_bed&extruder")
                RESULT=$(echo "$STATUS" | jq '.result.status')

                STATE=$(echo "$RESULT" | jq -r '.print_stats.state // "unknown"')
                FILENAME=$(echo "$RESULT" | jq -r '.print_stats.filename // "none"')
                PROGRESS=$(echo "$RESULT" | jq -r '.display_status.progress // 0')
                PROGRESS_PCT=$(echo "$PROGRESS * 100" | bc | cut -d. -f1)

                PRINT_DURATION=$(echo "$RESULT" | jq -r '.print_stats.print_duration // 0')
                TOTAL_DURATION=$(echo "$RESULT" | jq -r '.print_stats.total_duration // 0')

                NOZZLE_TEMP=$(echo "$RESULT" | jq -r '.extruder.temperature // 0')
                NOZZLE_TARGET=$(echo "$RESULT" | jq -r '.extruder.target // 0')
                BED_TEMP=$(echo "$RESULT" | jq -r '.heater_bed.temperature // 0')
                BED_TARGET=$(echo "$RESULT" | jq -r '.heater_bed.target // 0')

                echo "═══════════════════════════════════════════════════════════"
                echo "PRINT STATUS"
                echo "═══════════════════════════════════════════════════════════"
                echo "State:    $STATE"
                echo "File:     $FILENAME"
                echo "Progress: ${PROGRESS_PCT}%"
                echo ""
                echo "Temperatures:"
                echo "  Nozzle: ${NOZZLE_TEMP}°C / ${NOZZLE_TARGET}°C"
                echo "  Bed:    ${BED_TEMP}°C / ${BED_TARGET}°C"
                echo ""

                if [[ "$STATE" == "printing" ]]; then
                    # Calculate ETA
                    if [[ "$PROGRESS" != "0" ]] && [[ "$PRINT_DURATION" != "0" ]]; then
                        TOTAL_EST=$(echo "$PRINT_DURATION / $PROGRESS" | bc)
                        REMAINING=$((TOTAL_EST - PRINT_DURATION))
                        REMAINING_MIN=$((REMAINING / 60))
                        REMAINING_HR=$((REMAINING_MIN / 60))
                        REMAINING_MIN=$((REMAINING_MIN % 60))
                        echo "Time Remaining: ${REMAINING_HR}h ${REMAINING_MIN}m"
                    fi
                fi
                echo "═══════════════════════════════════════════════════════════"
                ;;

            octoprint)
                JOB=$(api_request GET "/api/job")
                STATE=$(echo "$JOB" | jq -r '.state // "unknown"')
                FILENAME=$(echo "$JOB" | jq -r '.job.file.name // "none"')
                PROGRESS=$(echo "$JOB" | jq -r '.progress.completion // 0')
                TIME_LEFT=$(echo "$JOB" | jq -r '.progress.printTimeLeft // 0')

                echo "═══════════════════════════════════════════════════════════"
                echo "PRINT STATUS"
                echo "═══════════════════════════════════════════════════════════"
                echo "State:    $STATE"
                echo "File:     $FILENAME"
                echo "Progress: ${PROGRESS}%"
                if [[ "$TIME_LEFT" != "null" ]] && [[ "$TIME_LEFT" != "0" ]]; then
                    echo "Time Left: $((TIME_LEFT / 60)) minutes"
                fi
                echo "═══════════════════════════════════════════════════════════"
                ;;

            *)
                echo "Print status not implemented for API type: $API_TYPE"
                exit 1
                ;;
        esac
        ;;

    # ───────────────────────────────────────────────────────────────────────────
    # Upload gcode file
    # ───────────────────────────────────────────────────────────────────────────
    upload)
        GCODE_PATH="$1"
        FILENAME="${2:-$(basename "$GCODE_PATH")}"

        if [[ ! -f "$GCODE_PATH" ]]; then
            echo "Error: File not found: $GCODE_PATH"
            exit 1
        fi

        echo "Uploading $FILENAME to printer..."
        RESULT=$(upload_file "$GCODE_PATH" "$FILENAME")

        if echo "$RESULT" | jq -e '.error' > /dev/null 2>&1; then
            echo "Error uploading file:"
            echo "$RESULT" | jq -r '.error'
            exit 1
        fi

        echo "✓ Upload complete: $FILENAME"
        ;;

    # ───────────────────────────────────────────────────────────────────────────
    # Start print
    # ───────────────────────────────────────────────────────────────────────────
    start)
        FILENAME="$1"
        if [[ -z "$FILENAME" ]]; then
            echo "Error: Filename required"
            exit 1
        fi

        echo "Starting print: $FILENAME"
        case "$API_TYPE" in
            moonraker)
                api_request POST "/printer/print/start?filename=${FILENAME}"
                ;;
            octoprint)
                api_request POST "/api/files/local/${FILENAME}" '{"command": "select", "print": true}'
                ;;
            *)
                echo "Start print not implemented for API type: $API_TYPE"
                exit 1
                ;;
        esac

        echo "✓ Print started"
        ;;

    # ───────────────────────────────────────────────────────────────────────────
    # Pause print
    # ───────────────────────────────────────────────────────────────────────────
    pause)
        echo "Pausing print..."
        case "$API_TYPE" in
            moonraker)
                api_request POST "/printer/print/pause"
                ;;
            octoprint)
                api_request POST "/api/job" '{"command": "pause", "action": "pause"}'
                ;;
            *)
                echo "Pause not implemented for API type: $API_TYPE"
                exit 1
                ;;
        esac
        echo "✓ Print paused"
        ;;

    # ───────────────────────────────────────────────────────────────────────────
    # Resume print
    # ───────────────────────────────────────────────────────────────────────────
    resume)
        echo "Resuming print..."
        case "$API_TYPE" in
            moonraker)
                api_request POST "/printer/print/resume"
                ;;
            octoprint)
                api_request POST "/api/job" '{"command": "pause", "action": "resume"}'
                ;;
            *)
                echo "Resume not implemented for API type: $API_TYPE"
                exit 1
                ;;
        esac
        echo "✓ Print resumed"
        ;;

    # ───────────────────────────────────────────────────────────────────────────
    # Cancel print
    # ───────────────────────────────────────────────────────────────────────────
    cancel)
        echo "Cancelling print..."
        case "$API_TYPE" in
            moonraker)
                api_request POST "/printer/print/cancel"
                ;;
            octoprint)
                api_request POST "/api/job" '{"command": "cancel"}'
                ;;
            *)
                echo "Cancel not implemented for API type: $API_TYPE"
                exit 1
                ;;
        esac
        echo "✓ Print cancelled"
        ;;

    # ───────────────────────────────────────────────────────────────────────────
    # List files on printer
    # ───────────────────────────────────────────────────────────────────────────
    files)
        case "$API_TYPE" in
            moonraker)
                FILES=$(api_request GET "/server/files/list")
                echo "Files on printer:"
                echo "$FILES" | jq -r '.result[] | "  \(.filename) (\(.size / 1024 | floor)KB)"'
                ;;
            octoprint)
                FILES=$(api_request GET "/api/files")
                echo "Files on printer:"
                echo "$FILES" | jq -r '.files[] | "  \(.name) (\(.size / 1024 | floor)KB)"'
                ;;
            *)
                echo "File listing not implemented for API type: $API_TYPE"
                exit 1
                ;;
        esac
        ;;

    # ───────────────────────────────────────────────────────────────────────────
    # Help
    # ───────────────────────────────────────────────────────────────────────────
    *)
        echo "Usage: printer-api.sh <command> [args...]"
        echo ""
        echo "Commands:"
        echo "  info              Get printer information"
        echo "  status            Get current print status"
        echo "  upload <file>     Upload gcode file to printer"
        echo "  start <filename>  Start printing a file"
        echo "  pause             Pause current print"
        echo "  resume            Resume paused print"
        echo "  cancel            Cancel current print"
        echo "  files             List files on printer"
        ;;
esac
