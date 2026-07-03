"""Promote Krea 2 weights from _staging_krea2/ into the canonical mlx-models
content-addressed store (manifest.json + symlinks + store-manifest entries).

Moves each weight file to ../video_generation__models/<md5>.safetensors (same
filesystem -> instant mv), then creates the in-tree mlx-models entry with a
manifest.json and a symlink. Small config.json files stay in-tree (copied).

After this, Swift RepoPaths resolves krea2 weights under mlx-models/ and the
staging dir holds only non-weight artifacts (pngs, scripts, pycache).

Run from repo root:
    ../video_generation__venv/bin/python swift/krea2-image-director/scripts/promote_krea2_weights.py
"""
import hashlib
import json
import os
import shutil

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
STORE = os.path.join(REPO_ROOT, "..", "video_generation__models")
STAGING = os.path.join(STORE, "_staging_krea2")
MLX_MODELS = os.path.join(REPO_ROOT, "mlx-models")
STORE_MANIFEST = os.path.join(MLX_MODELS, "store-manifest.json")

# (staging_relpath, mlx_category, mlx_name, in_tree_filename, keep_config)
ENTRIES = [
    ("turbo-q8.safetensors", "transformer", "krea2-turbo", "model.safetensors", False),
    ("vae/diffusion_pytorch_model.safetensors", "vae", "qwen-image-vae",
     "diffusion_pytorch_model.safetensors", True),
    ("qwen3-4b-instruct/model.safetensors", "text_encoder", "qwen3-4b-instruct",
     "model.safetensors", True),
]


def md5_file(path, chunk=1 << 24):
    h = hashlib.md5()
    sz = 0
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
            sz += len(b)
    return h.hexdigest(), sz


def symlink_rel_target(levels_up=4):
    # mlx-models/<cat>/<name>/<file> -> ../../../../video_generation__models/<md5>.safetensors
    return "../" * levels_up + "video_generation__models/"


def main():
    with open(STORE_MANIFEST) as f:
        store = json.load(f)
    files = store.setdefault("files", {})

    for staging_rel, cat, name, in_tree_name, keep_config in ENTRIES:
        src = os.path.join(STAGING, staging_rel)
        if not os.path.exists(src):
            print(f"SKIP (missing): {src}")
            continue
        print(f"[md5] {staging_rel} ...", end=" ", flush=True)
        digest, size = md5_file(src)
        print(digest)

        dst = os.path.join(STORE, f"{digest}.safetensors")
        if not os.path.exists(dst):
            shutil.move(src, dst)
            print(f"  mv -> {os.path.relpath(dst, STORE)}")
        else:
            print(f"  already in store; removing staging copy")
            os.remove(src)

        entry_dir = os.path.join(MLX_MODELS, cat, name)
        os.makedirs(entry_dir, exist_ok=True)
        link_src = os.path.join(entry_dir, in_tree_name)
        target = symlink_rel_target() + f"{digest}.safetensors"
        if os.path.islink(link_src) or os.path.exists(link_src):
            os.remove(link_src)
        os.symlink(target, link_src)
        print(f"  symlink {cat}/{name}/{in_tree_name} -> {target}")

        # store-manifest entry (path relative to store root)
        store_key = f"{cat}/{name}/{in_tree_name}"
        files[store_key] = {"md5": digest, "size": size}

        if keep_config:
            cfg_staging = os.path.join(os.path.dirname(src), "config.json")
            if os.path.exists(cfg_staging):
                shutil.copy2(cfg_staging, os.path.join(entry_dir, "config.json"))

        # manifest.json
        manifest = {
            "_comment": "Krea 2 Turbo weights for the pure-Swift krea2-image-director. "
            "Weights externalized to the content-addressed store; this in-tree "
            "entry is a symlink. See swift/krea2-image-director/.",
            "name": name, "type": cat,
            "weight_file": in_tree_name,
            "format": "mlx-8bit-g64" if name == "krea2-turbo" else ("qwen_image_vae" if cat == "vae" else "mlx-bf16"),
            "pipeline": ["krea2"],
            "size_bytes": size,
            "md5": digest,
            "symlink_to": target,
        }
        with open(os.path.join(entry_dir, "manifest.json"), "w") as f:
            json.dump(manifest, f, indent=2)

    store["count"] = len(files)
    with open(STORE_MANIFEST, "w") as f:
        json.dump(store, f, indent=2)
    print(f"\nstore-manifest: {store['count']} files")
    print("done")


if __name__ == "__main__":
    main()
