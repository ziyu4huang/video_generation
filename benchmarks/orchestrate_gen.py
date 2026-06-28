import json
import os
import subprocess
import shutil

CONFIG_PATH = "benchmarks/image_gen_compare/config.json"
OUTPUT_BASE = "benchmarks/image_gen_compare/raw_output"

def run_command(cmd, description):
    print(f"Running: {description}...")
    print(f"CMD: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Error: {result.stderr}")
        return False
    print(result.stdout)
    return True

def main():
    with open(CONFIG_PATH, "r") as f:
        config = json.load(f)

    common = config["common"]

    for test in config["tests"]:
        test_id = test["id"]
        print(f"\n=== Starting Test: {test['id']} ({test['name']}) ===")
        
        # Prepare output directories
        swift_dir = os.path.join(OUTPUT_BASE, test_id, "swift")
        python_dir = os.path.join(OUTPUT_BASE, test_id, "python")
        os.makedirs(swift_dir, exist_ok=True)
        os.makedirs(python_dir, exist_ok=True)

        # 1. Swift Generation
        # NOTE: Swift defaults to cfg_scale=4.0 (from manifest), but the model was
        # distilled at guidance 0.0. Python defaults to cfg OFF. We must explicitly
        # pass --cfg-scale 1.0 to Swift to match Python's single-forward behavior.
        swift_cmd = [
            "swift", "run", "--package-path", "swift/z-image-director", "zimage", "t2i",
            "--prompt", common["prompt"],
            "--seed", str(common["seed"]),
            "--width", str(test["width"]),
            "--height", str(test["height"]),
            "--cfg-scale", "1.0",
            "--output", os.path.join(swift_dir, f"result_{test_id}.png")
        ]
        
        if test["lora"]:
            swift_cmd.extend(["--lora", test["lora"]])
            # Note: We'll need to check if the LoRA name is correct for Swift vs Python
            # The config has the name from the python list. 
            # Let's check if Swift uses the same names.
        
        run_command(swift_cmd, f"Swift {test['name']}")

        # 2. Python Generation
        python_cmd = [
            "python/venv/bin/python", "python/mlx-movie-director/run.py", "image", "t2i",
            "--prompt", common["prompt"],
            "--seed", str(common["seed"]),
            "--width", str(test["width"]),
            "--height", str(test["height"]),
            "--output", os.path.join(python_dir, f"result_{test_id}.png")
        ]

        if test["lora"]:
            python_cmd.extend(["--lora", test["lora"]])

        run_command(python_cmd, f"Python {test['name']}")

if __name__ == "__main__":
    main()
