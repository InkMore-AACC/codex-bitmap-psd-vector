"""Conservative local registration proposals, never a semantic fidelity score.

Maps generated-file pixels to clean reference-crop pixels with one positive
scale and translation. No rotation, deformation, pixel extraction, or model
downloads. Rejected proposals must not be automatically applied.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np


def read_image(filename):
    image = cv2.imdecode(np.fromfile(str(filename), np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None:
        raise ValueError(f"Cannot decode image: {filename}")
    if image.ndim == 2:
        image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    return image


def fit_uniform(source, target):
    """Least-squares isotropic scale + translation; no arbitrary affine fit."""
    x = np.asarray(source, np.float64)
    y = np.asarray(target, np.float64)
    xm, ym = x.mean(axis=0), y.mean(axis=0)
    a, b = x - xm, y - ym
    denominator = float(np.sum(a * a))
    if denominator < 1e-8:
        raise ValueError("Degenerate correspondences")
    scale = float(np.sum(a * b) / denominator)
    return scale, ym - scale * xm


def search_bounds(reference, search_box):
    if search_box is None:
        return None
    b=np.asarray(search_box,dtype=np.float64)
    if b.shape!=(4,) or not np.isfinite(b).all() or min(b[2:])<=0 or min(b[:2])<0 or b[0]+b[2]>reference.shape[1] or b[1]+b[3]>reference.shape[0]:
        raise ValueError('Frozen measurement search box outside reference')
    return b


def feature_matches(generated, reference, method="sift", search_box=None):
    source_gray = cv2.cvtColor(generated[:, :, :3], cv2.COLOR_BGR2GRAY)
    target_gray = cv2.cvtColor(reference[:, :, :3], cv2.COLOR_BGR2GRAY)
    source_mask = None
    if generated.shape[2] == 4:
        source_mask = (generated[:, :, 3] >= 64).astype(np.uint8) * 255
        source_mask = cv2.erode(source_mask, np.ones((5, 5), np.uint8))
    source_scale = min(1.0, 2048 / max(source_gray.shape))
    target_scale = min(1.0, 2048 / max(target_gray.shape))
    if source_scale < 1:
        source_gray = cv2.resize(source_gray, None, fx=source_scale, fy=source_scale, interpolation=cv2.INTER_AREA)
        if source_mask is not None:
            source_mask = cv2.resize(source_mask, (source_gray.shape[1], source_gray.shape[0]), interpolation=cv2.INTER_NEAREST)
    if target_scale < 1:
        target_gray = cv2.resize(target_gray, None, fx=target_scale, fy=target_scale, interpolation=cv2.INTER_AREA)
    detector = (cv2.SIFT_create(nfeatures=7000, contrastThreshold=0.025)
                if method == "sift" else cv2.ORB_create(nfeatures=7000))
    norm = cv2.NORM_L2 if method == "sift" else cv2.NORM_HAMMING
    source_keypoints, source_descriptors = detector.detectAndCompute(source_gray, source_mask)
    target_mask=None
    box=search_bounds(reference,search_box)
    if box is not None:
        x,y,w,h=box*target_scale
        target_mask=np.zeros(target_gray.shape,np.uint8)
        target_mask[int(np.ceil(y)):int(np.floor(y+h)),int(np.ceil(x)):int(np.floor(x+w))]=255
    target_keypoints, target_descriptors = detector.detectAndCompute(target_gray, target_mask)
    if source_descriptors is None or target_descriptors is None:
        return np.empty((0, 2)), np.empty((0, 2)), (len(source_keypoints), len(target_keypoints))
    matcher = cv2.BFMatcher(norm)
    def ratio_matches(a, b):
        return {m.queryIdx: m.trainIdx for pair in matcher.knnMatch(a, b, k=2)
                if len(pair) == 2 for m, n in [pair] if m.distance < 0.72 * n.distance}
    forward, reverse = ratio_matches(source_descriptors, target_descriptors), ratio_matches(target_descriptors, source_descriptors)
    pairs = []
    for i, k in forward.items():
        if reverse.get(k) != i:
            continue
        # SIFT may give the same point several orientations. Count independent
        # locations, not repeated descriptors, toward the inlier requirement.
        a, b = np.array(source_keypoints[i].pt), np.array(target_keypoints[k].pt)
        if any(np.linalg.norm(a - np.array(source_keypoints[u].pt)) < 2 or
               np.linalg.norm(b - np.array(target_keypoints[v].pt)) < 2 for u, v in pairs):
            continue
        pairs.append((i, k))
    return (np.asarray([source_keypoints[i].pt for i, _ in pairs], dtype=np.float64).reshape(-1, 2) / source_scale,
            np.asarray([target_keypoints[k].pt for _, k in pairs], dtype=np.float64).reshape(-1, 2) / target_scale,
            (len(source_keypoints), len(target_keypoints)))


def estimate(generated, reference, method="sift", seed=0, search_box=None):
    box=search_bounds(reference,search_box)
    source, target, features = (feature_matches(generated,reference,method,box) if box is not None
                                else feature_matches(generated,reference,method))
    result = {"accepted": False, "method": method, "sourceSize": [generated.shape[1], generated.shape[0]],
              "referenceSize": [reference.shape[1], reference.shape[0]], "featureCounts": list(features),
              "matchCount": len(source), "scope": "geometric proposal only; does not prove semantic or visual fidelity"}
    if box is not None: result['measurementSearchBox']=box.tolist()
    if len(source) < 12:
        return {**result, "reason": "insufficient mutually unique feature matches"}
    # Reserve one quarter BEFORE RANSAC/model selection. The held-out targets
    # never participate in fitting, and are not chosen by a good residual.
    order = np.lexsort((source[:, 1], source[:, 0]))
    validation = np.zeros(len(source), dtype=bool)
    validation[order[1::4]] = True
    training = ~validation
    threshold = max(2.0, min(reference.shape[:2]) * 0.003)
    generator = np.random.default_rng(seed)
    best = None
    for _ in range(min(4000, len(source) * 40)):
        indices = generator.choice(np.flatnonzero(training), 2, replace=False)
        if np.linalg.norm(source[indices[0]] - source[indices[1]]) < min(generated.shape[:2]) * 0.08:
            continue
        scale, offset = fit_uniform(source[indices], target[indices])
        if scale <= 0:
            continue
        residuals = np.linalg.norm(source * scale + offset - target, axis=1)
        inliers = (residuals <= threshold) & training
        score = (int(inliers.sum()), -float(np.median(residuals[inliers])) if inliers.any() else -1e9)
        if best is None or score > best[0]:
            best = (score, inliers)
    if best is None or best[1].sum() < 3:
        return {**result, "reason": "no consistent positive uniform transform"}
    inliers = best[1]
    for _ in range(4):
        scale, offset = fit_uniform(source[inliers], target[inliers])
        residuals = np.linalg.norm(source * scale + offset - target, axis=1)
        updated = (residuals <= threshold) & training
        if updated.sum() < 3 or np.array_equal(updated, inliers):
            break
        inliers = updated
    # Recompute from the final training set, without leaking validation points.
    scale, offset = fit_uniform(source[inliers], target[inliers])
    residuals = np.linalg.norm(source * scale + offset - target, axis=1)
    count = int(inliers.sum())
    if generated.shape[2] == 4 and np.any(generated[:, :, 3] >= 64):
        ys, xs = np.where(generated[:, :, 3] >= 64)
        source_extent = np.array([max(1, xs.max() - xs.min()), max(1, ys.max() - ys.min())])
    else:
        source_extent = np.array([generated.shape[1], generated.shape[0]])
    coverage = np.ptp(source[inliers], axis=0) / source_extent
    hull = cv2.convexHull(source[inliers].astype(np.float32))
    hull_coverage = float(cv2.contourArea(hull) / np.prod(source_extent))
    # Independent spatial support matters: many points all on one ear/eye are
    # not evidence that the entire person has the same pose or scale.
    reasons = []
    if count < 12: reasons.append("fewer than 12 inliers")
    if count / int(training.sum()) < 0.4: reasons.append("inlier ratio below 0.40")
    if min(coverage) < 0.35: reasons.append("inliers do not span enough of both object dimensions")
    if hull_coverage < 0.07: reasons.append("inliers concentrated in a small or nearly collinear area")
    if scale <= 0: reasons.append("non-positive scale")
    checked = validation & (residuals <= threshold)
    validation_count = int(validation.sum())
    passing_count = int(checked.sum())
    passing_ratio = passing_count / validation_count
    validation_coverage = (np.ptp(source[checked], axis=0) / source_extent
                           if passing_count >= 2 else np.zeros(2))
    if passing_count < 4: reasons.append("fewer than 4 held-out matches")
    if passing_ratio < 0.6: reasons.append("held-out support below 0.60")
    if min(validation_coverage) < 0.2: reasons.append("held-out matches lack spatial support")
    holdout = {"version": 1, "split": "source-x-y-order-quarter-before-fit", "trainingCount": int(training.sum()),
               "validationCount": validation_count, "passingCount": passing_count, "passingRatio": passing_ratio,
               "sourceExtent": source_extent.tolist(), "sourceCoverage": validation_coverage.tolist(),
               "residualThreshold": threshold, "minimumPassingCount": 4, "minimumPassingRatio": 0.6,
               "minimumCoverage": 0.2, "usedForFit": False}
    result.update({"accepted": not reasons, "reason": "; ".join(reasons) or "spatially distributed uniform correspondence",
                   "scale": scale, "translation": offset.tolist(), "residualThreshold": threshold,
                   "inlierCount": count, "inlierRatio": count / int(training.sum()), "sourceCoverage": coverage.tolist(),
                   "holdout": holdout,
                   "sourceHullCoverage": hull_coverage, "residualMedian": float(np.median(residuals[inliers])),
                   "residualP95": float(np.percentile(residuals[inliers], 95)),
                   "points": [{"source": a.tolist(), "target": b.tolist(), "inlier": bool(ok), "residual": float(e),
                               "role": "validation" if reserve else "fit"}
                              for a, b, ok, e, reserve in zip(source, target, inliers, residuals, validation)]})
    return result


def contour_candidate_distance(a,b):
    """Absolute reference-pixel displacement of the definite contour rectangle.

    Scale percentage alone invents competitors for tiny objects: 3% of a
    42-pixel marker is a one-pixel raster phase, while 3% of a word may be
    many pixels. Conversely a same-scale two-pixel-plus shift is distinct.
    """
    _,_,ax,ay,aw,ah=a;_,_,bx,by,bw,bh=b
    return float(max(np.hypot(ax-bx,ay-by),np.hypot(ax+aw-bx-bw,ay-by),
                     np.hypot(ax-bx,ay+ah-by-bh),np.hypot(ax+aw-bx-bw,ay+ah-by-bh)))


def estimate_edges(generated, reference, search_box=None):
    """Conservative alpha-contour registration for feature-poor typography.

    All reference pixels are used only for measurements. The result is a
    proposal, not an extracted image or proof that the words are correct.
    """
    result = {"accepted": False, "method": "edge", "sourceSize": [generated.shape[1], generated.shape[0]],
              "referenceSize": [reference.shape[1], reference.shape[0]], "featureCounts": [0, 0],
              "matchCount": 0, "scope": "contour placement only; does not prove words, color, or semantic fidelity"}
    box=search_bounds(reference,search_box)
    if box is not None: result['measurementSearchBox']=box.tolist()
    if generated.shape[2] != 4:
        return {**result, "reason": "alpha contour unavailable"}
    alpha = generated[:, :, 3]
    ys, xs = np.where(alpha > 96)
    if len(xs) < 100:
        return {**result, "reason": "insufficient definite alpha contour"}
    sx, sy, right, bottom = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
    mask = alpha[sy:bottom, sx:right]
    target_scale = min(1., 1600 / max(reference.shape[:2]))
    gray = cv2.cvtColor(reference[:, :, :3], cv2.COLOR_BGR2GRAY)
    if target_scale < 1:
        gray = cv2.resize(gray, None, fx=target_scale, fy=target_scale, interpolation=cv2.INTER_AREA)
    h, w = gray.shape
    edge = cv2.Canny(gray, 60, 120)
    density = float(np.mean(edge > 0))
    if np.count_nonzero(edge) < 30 or density > 0.3:
        return {**result, "reason": "reference edges absent or too dense for unique contour registration"}
    distance = cv2.distanceTransform(255 - edge, cv2.DIST_L2, 3).astype(np.float32)
    base = max(w / generated.shape[1], h / generated.shape[0])
    candidates = []
    for scale in np.linspace(base * 0.6, base * 1.3, 111):
        ww, hh = int(round(mask.shape[1] * scale)), int(round(mask.shape[0] * scale))
        if ww > w or hh > h or min(ww, hh) < 4:
            continue
        template = cv2.Canny(cv2.resize(mask, (ww, hh), interpolation=cv2.INTER_AREA), 48, 96).astype(np.float32) / 255
        count = float(template.sum())
        if count < 60:
            continue
        scores = cv2.matchTemplate(distance, template, cv2.TM_CCORR) / count
        if box is not None:
            bx,by,bw,bh=box*target_scale
            # Keep reference coordinates and full generated alpha. Only discard
            # hypotheses whose entire definite contour is outside the frozen scope.
            x0,y0=int(np.ceil(bx)),int(np.ceil(by))
            x1,y1=int(np.floor(bx+bw-ww)),int(np.floor(by+bh-hh))
            if x1<x0 or y1<y0: continue
            scores[:y0,:]=np.inf;scores[y1+1:,:]=np.inf
            scores[:,:x0]=np.inf;scores[:,x1+1:]=np.inf
        # Keep spatially separated alternatives, not just one minimum per scale.
        for _ in range(3):
            score, _, location, _ = cv2.minMaxLoc(scores)
            x, y = location
            if not np.isfinite(score):
                break
            candidates.append((max(0., score), float(scale), x, y, ww, hh))
            radius = max(4, int(min(ww, hh) * 0.2))
            scores[max(0, y-radius):y+radius+1, max(0, x-radius):x+radius+1] = np.inf
    if not candidates:
        return {**result, "reason": "no contour fits the reference viewport"}
    candidates.sort()
    score, scale, x, y, ww, hh = candidates[0]
    # Compare different placements, not duplicate hypotheses for the same
    # integer contour. Score/gap, coverage and orientation gates stay unchanged.
    alternative = next((c for c in candidates[1:] if contour_candidate_distance(c,candidates[0])>2),None)
    gap = float(alternative[0] - score) if alternative else 999.
    template = cv2.Canny(cv2.resize(mask, (ww, hh), interpolation=cv2.INTER_AREA), 48, 96)
    ty, tx = np.where(template > 0)
    errors = distance[y + ty, x + tx]
    covered = errors <= 1.5
    coverage = float(covered.mean())
    # Eight strips require distributed support across the text; a single matched
    # letter must not move the rest of a word into a guessed position.
    stripe_coverage = []
    for strip in range(8):
        local = (tx >= strip * ww / 8) & (tx < (strip + 1) * ww / 8)
        if local.sum() >= 10:
            stripe_coverage.append(float(covered[local].mean()))
    _, labels = cv2.distanceTransformWithLabels(255-edge, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    ey, ex = np.where(edge > 0)
    nearest = labels[y + ty, x + tx] - 1
    qx, qy = ex[nearest], ey[nearest]
    gx, gy = cv2.Sobel(gray, cv2.CV_32F, 1, 0), cv2.Sobel(gray, cv2.CV_32F, 0, 1)
    scaled_alpha = cv2.resize(mask, (ww, hh), interpolation=cv2.INTER_AREA)
    ax, ay = cv2.Sobel(scaled_alpha, cv2.CV_32F, 1, 0), cv2.Sobel(scaled_alpha, cv2.CV_32F, 0, 1)
    orientation = np.abs(ax[ty, tx] * gx[qy, qx] + ay[ty, tx] * gy[qy, qx]) / (
        np.hypot(ax[ty, tx], ay[ty, tx]) * np.hypot(gx[qy, qx], gy[qy, qx]) + 1e-6)
    orientation = np.clip(orientation, 0., 1.)
    orientation_agreement = float(np.median(orientation[covered])) if covered.any() else 0.
    reasons = []
    if score > 0.85: reasons.append("mean contour distance exceeds 0.85 pixels")
    if coverage < 0.86: reasons.append("less than 86 percent of contour has close reference support")
    if not stripe_coverage or min(stripe_coverage) < 0.7: reasons.append("some contour regions lack distributed support")
    if gap < 0.35 or (alternative and alternative[0] < score * 1.4): reasons.append("competing placement is too similar")
    if orientation_agreement < 0.86: reasons.append("contour orientations disagree")
    # Correspondences retain original source and reference pixel units. They are
    # measurements of edge locations, not moved targets chosen to pass a gate.
    good = np.flatnonzero(covered & (orientation >= 0.75))
    if len(good) > 400:
        good = good[np.linspace(0, len(good) - 1, 400, dtype=int)]
    points = [{"source": [float(tx[k] / scale + sx), float(ty[k] / scale + sy)],
               "target": [float(qx[k] / target_scale), float(qy[k] / target_scale)],
               "inlier": True, "residual": float(errors[k] / target_scale)} for k in good]
    result.update({"accepted": not reasons, "reason": "; ".join(reasons) or "unique distributed contour support",
                   "scale": scale / target_scale, "translation": [(x-scale*sx)/target_scale, (y-scale*sy)/target_scale],
                   "matchCount": len(tx), "inlierCount": len(points), "inlierRatio": coverage,
                   "residualMedian": float(np.median(errors)/target_scale),
                   "residualP95": float(np.percentile(errors,95)/target_scale), "residualThreshold": 1.5/target_scale,
                   "contourEvidence": {"meanDistance": float(score), "coverage": coverage,
                                       "minimumStripeCoverage": min(stripe_coverage) if stripe_coverage else 0.,
                                       "alternativeGap": gap, "orientationAgreement": orientation_agreement,
                                       "targetAnalysisScale": target_scale,
                                       "distinctPlacementPixels":2/target_scale,
                                       "bestBounds":[x/target_scale,y/target_scale,ww/target_scale,hh/target_scale],
                                       "alternativeBounds":([v/target_scale for v in alternative[2:]] if alternative else None)}, "points": points})
    return result


def diagnostic(generated, reference, result, output):
    """Disposable review image only, never returned as a generated layer."""
    h, w = reference.shape[:2]
    rgba = generated if generated.shape[2] == 4 else cv2.cvtColor(generated, cv2.COLOR_BGR2BGRA)
    baseline = min(w / rgba.shape[1], h / rgba.shape[0])
    bx, by = (w - rgba.shape[1] * baseline) / 2, (h - rgba.shape[0] * baseline) / 2
    transforms = [(baseline, bx, by), (result.get("scale", baseline), *result.get("translation", [bx, by]))]
    panels = [reference[:, :, :3]]
    for scale, x, y in transforms:
        warped = cv2.warpAffine(rgba, np.array([[scale, 0, x], [0, scale, y]], np.float64), (w, h))
        alpha = warped[:, :, 3:4].astype(np.float32) / 255
        on_gray = warped[:, :, :3] * alpha + 128 * (1 - alpha)
        overlay = reference[:, :, :3] * (1 - alpha * 0.5) + warped[:, :, :3] * alpha * 0.5
        panels.extend([on_gray.astype(np.uint8), overlay.astype(np.uint8)])
    image = np.concatenate(panels, axis=1)
    cv2.imencode('.png', image)[1].tofile(str(output))


def estimate_auto(generated, reference, search_box=None):
    sift = estimate(generated, reference,search_box=search_box)
    if sift['accepted']:
        return sift
    if sift.get('holdout'):
        # Internal feature disagreement must not be hidden by matching only
        # the alpha perimeter of a printed object.
        return {**sift, "reason": sift['reason'] + "; feature evidence rejected, contour fallback disabled"}
    contour = estimate_edges(generated, reference,search_box=search_box)
    contour['attempts'] = [
        {k: v for k, v in result.items() if k in
         ('method', 'accepted', 'reason', 'matchCount', 'inlierCount', 'inlierRatio', 'contourEvidence')}
        for result in (sift, contour)
    ]
    return contour


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--generated", required=True)
    parser.add_argument("--reference", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--method", choices=["sift", "orb", "edge", "auto"], default="sift")
    parser.add_argument("--no-diagnostic", action="store_true")
    parser.add_argument("--search-box", help="Frozen reference pixel measurement scope [x,y,width,height]; never an output crop")
    args = parser.parse_args()
    generated, reference = read_image(args.generated), read_image(args.reference)
    search_box=json.loads(args.search_box) if args.search_box else None
    result = (estimate_auto(generated, reference,search_box) if args.method == 'auto'
              else estimate_edges(generated, reference,search_box) if args.method == 'edge'
              else estimate(generated, reference, args.method,search_box=search_box))
    p = Path(args.output)
    p.parent.mkdir(parents=True, exist_ok=True)
    if not args.no_diagnostic:
        diagnostic(generated, reference, result, p.with_suffix('.png'))
        result["diagnosticPath"] = str(p.with_suffix('.png').resolve())
    p.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in result.items() if k != "points"}, ensure_ascii=False))


if __name__ == '__main__':
    main()
