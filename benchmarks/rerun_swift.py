import json
import os
import subprocess

CONFIG_PATH = "benchmarks/image_gen_compare/config.json"
OUTPUT_BASE = "benchmarks/image_gen_compare/raw_output"

def main():
    with open(CONFIG_PATH, "r") as f:
        config = json.load(f)

    common = config["common"]

    for test in config["tests"]:
        test_id = test["id"]
        print(f"\n=== Re-running Swift: {test['id']} ({test['name']}) === [cfg-scale=1.0]")
        
        swift_dir = os.path.join(OUTPUT_BASE, test_id, "swift")
        os.makedirs(swift_dir, exist_ok=True)

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
        
        print(f"CMD: {' '.join(swift_cmd)}")
        result = subprocess.run(swift_cmd, capture_output=False, text=True)

if __name__ == "__main__":
    main()
