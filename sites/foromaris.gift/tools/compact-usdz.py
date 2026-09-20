"""Repack a three.js-exported USDZ (ASCII usda) as a binary-crate USDZ.

Quick Look reads both, but the crate file is a fraction of the size. Also
prints a few sanity checks so a bad package never ships.

    python3 tools/compact-usdz.py public/Omaris/omaris.usdz
"""
import os
import shutil
import sys
import tempfile
import zipfile

from pxr import Usd, UsdGeom, UsdUtils

src = sys.argv[1]
before = os.path.getsize(src)
work = tempfile.mkdtemp(prefix="usdz-")
try:
    with zipfile.ZipFile(src) as z:
        z.extractall(work)
    stage = Usd.Stage.Open(os.path.join(work, "model.usda"))
    flat = stage.Flatten()
    flat.Export(os.path.join(work, "model.usdc"))
    # rebuild a fresh stage from the crate so dependency discovery is clean
    out_tmp = os.path.join(work, "packed.usdz")
    ok = UsdUtils.CreateNewARKitUsdzPackage(os.path.join(work, "model.usdc"), out_tmp)
    if not ok:
        raise SystemExit("CreateNewARKitUsdzPackage failed")

    # sanity: opens, keeps units and anchoring, textures resolved inside the package
    check = Usd.Stage.Open(out_tmp)
    scene = check.GetPrimAtPath("/Root/Scenes/Scene")
    anchoring = scene.GetAttribute("preliminary:anchoring:type").Get() if scene else None
    with zipfile.ZipFile(out_tmp) as z:
        names = z.namelist()
        aligned = all((i.header_offset + 30 + len(i.filename) + len(i.extra)) % 64 == 0 and i.compress_type == 0 for i in z.infolist())
    textures = [n for n in names if n.lower().endswith((".png", ".jpg", ".jpeg"))]
    bbox = UsdGeom.BBoxCache(Usd.TimeCode.Default(), ["default", "render"]).ComputeWorldBound(check.GetPseudoRoot()).ComputeAlignedRange()
    unresolved = [p for p in UsdUtils.ComputeAllDependencies(out_tmp)[2] if p]
    if not aligned or anchoring != "plane" or not textures or unresolved:
        raise SystemExit(f"repack failed checks: aligned={aligned} anchoring={anchoring} textures={len(textures)} unresolved={unresolved}")
    shutil.copyfile(out_tmp, src)
    after = os.path.getsize(src)
    print(
        f"{os.path.basename(src)}: {before/1024:.0f} KB → {after/1024:.0f} KB, "
        f"{len(textures)} textures, height {bbox.GetMax()[1]-bbox.GetMin()[1]:.3f} m, anchoring={anchoring}"
    )
finally:
    shutil.rmtree(work, ignore_errors=True)
