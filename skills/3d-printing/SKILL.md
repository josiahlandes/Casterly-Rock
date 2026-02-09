---
name: 3d-printing
description: Slice 3D models, manage print presets, upload to printer, and monitor print jobs on Elegoo Centauri Carbon
homepage: https://www.elegoo.com/products/elegoo-centauri-carbon
metadata:
  openclaw:
    emoji: "🖨️"
    os: ["darwin", "linux"]
    requires:
      bins: ["orca-slicer", "curl", "jq"]
      envVars: []
    install:
      - id: orcaslicer
        kind: manual
        instructions: "Download OrcaSlicer from https://github.com/SoftFever/OrcaSlicer/releases"
tools:
  - name: slice_model
    description: Slice a 3D model file (.stl, .3mf, .obj) into gcode using specified presets
    inputSchema:
      type: object
      properties:
        model_path:
          type: string
          description: Path to the 3D model file (.stl, .3mf, .obj)
        filament_preset:
          type: string
          description: Name of the filament preset (e.g., "pla_basic", "petg_strong")
        quality_preset:
          type: string
          description: Name of the quality preset (e.g., "draft", "standard", "fine")
        output_description:
          type: string
          description: Short description for the output folder name
      required:
        - model_path
        - filament_preset
        - quality_preset
        - output_description

  - name: list_presets
    description: List all available filament and quality presets from the configuration
    inputSchema:
      type: object
      properties:
        preset_type:
          type: string
          description: Type of presets to list
          enum: ["filament", "quality", "all"]
      required:
        - preset_type

  - name: save_preset
    description: Create or update a filament or quality preset in the configuration
    inputSchema:
      type: object
      properties:
        preset_type:
          type: string
          description: Type of preset
          enum: ["filament", "quality"]
        name:
          type: string
          description: Unique name for the preset
        settings:
          type: object
          description: Preset settings (varies by type)
      required:
        - preset_type
        - name
        - settings

  - name: delete_preset
    description: Delete a filament or quality preset from the configuration
    inputSchema:
      type: object
      properties:
        preset_type:
          type: string
          description: Type of preset to delete
          enum: ["filament", "quality"]
        name:
          type: string
          description: Name of the preset to delete
      required:
        - preset_type
        - name

  - name: find_models
    description: Search for 3D model files in a directory
    inputSchema:
      type: object
      properties:
        search_path:
          type: string
          description: Directory path to search for models
        pattern:
          type: string
          description: Optional filename pattern to filter (e.g., "benchy", "*.stl")
        recursive:
          type: boolean
          description: Search subdirectories recursively
      required:
        - search_path

  - name: list_sliced_jobs
    description: List previously sliced jobs with their gcode files
    inputSchema:
      type: object
      properties:
        limit:
          type: integer
          description: Maximum number of jobs to list (default 10)
      required: []

  - name: upload_to_printer
    description: Upload a gcode file to the Elegoo Centauri Carbon printer over the network
    inputSchema:
      type: object
      properties:
        gcode_path:
          type: string
          description: Path to the gcode file to upload
        filename:
          type: string
          description: Optional filename to use on the printer (defaults to original name)
      required:
        - gcode_path

  - name: start_print
    description: Start printing a file that has been uploaded to the printer
    inputSchema:
      type: object
      properties:
        filename:
          type: string
          description: Name of the gcode file on the printer to start printing
      required:
        - filename

  - name: check_print_status
    description: Get the current print status from the printer
    inputSchema:
      type: object
      properties: {}
      required: []

  - name: get_printer_info
    description: Get printer connection status and basic information
    inputSchema:
      type: object
      properties: {}
      required: []

  - name: cancel_print
    description: Cancel the current print job
    inputSchema:
      type: object
      properties:
        confirm:
          type: boolean
          description: Must be true to confirm cancellation
      required:
        - confirm

  - name: pause_print
    description: Pause the current print job
    inputSchema:
      type: object
      properties: {}
      required: []

  - name: resume_print
    description: Resume a paused print job
    inputSchema:
      type: object
      properties: {}
      required: []
---

# 3D Printing Skill

Control the complete 3D printing workflow: slicing models, managing presets, uploading to printer, and monitoring jobs.

## Configuration

Presets are stored in `~/.casterly/config/3d-printing.yaml`. The configuration includes:
- **Filament presets**: Material-specific settings (temperature, flow, retraction)
- **Quality presets**: Layer height, speed, infill settings
- **Printer settings**: Network address, API endpoints

## Workflow

### 1. Find or Receive Model

Use `find_models` to search for 3D model files:
```
find_models("/Users/name/Downloads", "benchy", recursive=true)
```

Supported formats: `.stl`, `.3mf`, `.obj`

### 2. Choose Presets

List available presets:
```
list_presets("all")
```

Common filament presets:
- `pla_basic` - Standard PLA settings
- `pla_plus` - Enhanced PLA for better layer adhesion
- `petg_standard` - PETG with typical settings
- `petg_strong` - Higher temp PETG for strength
- `abs_standard` - ABS with enclosure settings
- `tpu_flexible` - TPU for flexible prints

Common quality presets:
- `draft` - 0.3mm layer, fast printing
- `standard` - 0.2mm layer, balanced
- `fine` - 0.12mm layer, detailed
- `ultra_fine` - 0.08mm layer, maximum detail

### 3. Slice the Model

```
slice_model(
  model_path="/path/to/model.stl",
  filament_preset="pla_basic",
  quality_preset="standard",
  output_description="benchy test print"
)
```

This will:
1. Load the model and presets
2. Slice using OrcaSlicer CLI
3. Save to `~/.casterly/prints/YYYY-MM-DD_description/`
4. Store both original model and generated gcode

### 4. Upload and Print

Upload the sliced gcode:
```
upload_to_printer("/path/to/output.gcode")
```

Start the print:
```
start_print("output.gcode")
```

### 5. Monitor Progress

Check status anytime:
```
check_print_status()
```

Returns:
- Print state (printing, paused, idle, error)
- Progress percentage
- Estimated time remaining
- Current layer
- Temperatures (bed, nozzle)

## Managing Presets

### Create a new filament preset

```
save_preset(
  preset_type="filament",
  name="silk_pla",
  settings={
    "material": "PLA",
    "nozzle_temp": 215,
    "bed_temp": 60,
    "flow_ratio": 0.98,
    "retraction_length": 0.8,
    "retraction_speed": 35,
    "notes": "Silk PLA needs slightly higher temp"
  }
)
```

### Create a new quality preset

```
save_preset(
  preset_type="quality",
  name="speed_draft",
  settings={
    "layer_height": 0.28,
    "first_layer_height": 0.3,
    "infill_percentage": 10,
    "wall_loops": 2,
    "top_layers": 3,
    "bottom_layers": 3,
    "print_speed": 150,
    "travel_speed": 250,
    "notes": "Fast draft for prototypes"
  }
)
```

## Printer Control

### Connection

The printer is accessed via its network API. Configure in `3d-printing.yaml`:
```yaml
printer:
  name: "Elegoo Centauri Carbon"
  address: "192.168.1.100"
  port: 80
  api_type: "moonraker"  # or "elegoo" for native API
```

### Emergency Stop

If something goes wrong:
```
cancel_print(confirm=true)
```

### Pause/Resume

```
pause_print()
resume_print()
```

## Output Structure

Sliced jobs are stored in:
```
~/.casterly/prints/
└── 2024-01-15_benchy-test-print/
    ├── model.stl           # Original model
    ├── output.gcode        # Sliced gcode
    ├── metadata.json       # Slice settings used
    └── thumbnail.png       # Preview (if available)
```

## Tips

1. **Always check presets** before slicing a new material
2. **Test filament settings** with a temperature tower first
3. **Use draft quality** for fit checks, fine for final prints
4. **Monitor first layer** - most failures happen early
5. **Keep presets updated** as you dial in your printer

## Troubleshooting

### Slicer not found
Install OrcaSlicer and ensure `orca-slicer` is in your PATH.

### Printer not responding
1. Check printer is powered on and connected to network
2. Verify IP address in configuration
3. Try `get_printer_info()` to test connection

### Slice fails
1. Check model is valid (not corrupted)
2. Try opening in a 3D viewer first
3. Check preset names are correct
