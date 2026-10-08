import unittest
import cv2
import numpy as np
from unittest.mock import patch
from generation_registration import estimate, fit_uniform, estimate_edges, estimate_auto,contour_candidate_distance


def fixture():
    rng = np.random.default_rng(13)
    image = np.zeros((480, 640, 4), np.uint8)
    image[:, :, :3] = 40
    image[20:460, 20:620, 3] = 255
    for _ in range(120):
        x, y = rng.integers([40, 40], [600, 440])
        color = tuple(int(c) for c in rng.integers(50, 250, 3)) + (255,)
        cv2.circle(image, (int(x), int(y)), int(rng.integers(3, 12)), color, -1)
    return image


class RegistrationTests(unittest.TestCase):
    def test_distinct_competitor_uses_actual_contour_displacement_not_relative_scale(self):
        tiny=(.2,.36,304,53,42,44)
        self.assertLess(contour_candidate_distance(tiny,(.3,.38,303,53,43,45)),2)
        self.assertGreater(contour_candidate_distance(tiny,(.3,.36,307,53,42,44)),2)
        word=(.2,.36,30,20,600,80)
        self.assertGreater(contour_candidate_distance(word,(.3,.37,30,20,618,82)),2)
    def test_exact_uniform_math(self):
        a = np.array([[10., 20.], [120., 80.], [50., 250.]])
        scale, offset = fit_uniform(a, a * 1.4 + [12, -7])
        self.assertAlmostEqual(scale, 1.4)
        np.testing.assert_allclose(offset, [12, -7])

    def test_distributed_uniform_match(self):
        source = fixture()
        target = cv2.warpAffine(source, np.array([[0.8, 0, 15], [0, 0.8, 20]], np.float64), (640, 480))
        result = estimate(source, target[:, :, :3])
        self.assertTrue(result['accepted'], result)
        self.assertAlmostEqual(result['scale'], 0.8, delta=0.003)
        np.testing.assert_allclose(result['translation'], [15, 20], atol=0.5)
        self.assertFalse(result['holdout']['usedForFit'])
        self.assertGreaterEqual(result['holdout']['passingCount'], 4)
        self.assertTrue(all(not p['inlier'] for p in result['points'] if p['role'] == 'validation'))

    def test_good_training_fit_does_not_hide_held_out_deformation(self):
        source = fixture()
        points = np.array([[x,y] for x in np.linspace(30,600,8) for y in np.linspace(30,440,8)])
        targets = points * 0.8 + [15,20]
        order = np.lexsort((points[:,1],points[:,0]))
        targets[order[1::4]] += [12,-9]
        with patch('generation_registration.feature_matches', return_value=(points,targets,(64,64))):
            result = estimate(source,source[:,:,:3])
            self.assertFalse(result['accepted'],result)
            self.assertEqual(result['inlierCount'],48)
            self.assertEqual(result['holdout']['passingCount'],0)
            self.assertIn('held-out',result['reason'])
            with patch('generation_registration.estimate_edges') as contour:
                automatic = estimate_auto(source,source[:,:,:3])
                self.assertFalse(automatic['accepted'])
                contour.assert_not_called()

    def test_good_held_out_matches_are_not_picked_by_residual(self):
        source = fixture()
        points = np.array([[x,y] for x in np.linspace(30,600,8) for y in np.linspace(30,440,8)])
        targets = points * 0.8 + [15,20]
        with patch('generation_registration.feature_matches', return_value=(points,targets,(64,64))):
            result = estimate(source,source[:,:,:3])
            self.assertTrue(result['accepted'],result)
            self.assertEqual(result['holdout']['validationCount'],16)
            self.assertEqual(result['holdout']['passingCount'],16)
            self.assertEqual(result['inlierCount'],48)

    def test_no_texture_rejected(self):
        image = np.full((300, 300, 4), 255, np.uint8)
        result = estimate(image, image[:, :, :3])
        self.assertFalse(result['accepted'])

    def test_nonuniform_deformation_rejected(self):
        source = fixture()
        target = cv2.warpAffine(source, np.array([[0.6, 0, 15], [0, 0.9, 20]], np.float64), (640, 480))
        self.assertFalse(estimate(source, target[:, :, :3])['accepted'])

    def test_concentrated_matches_rejected(self):
        source = fixture()
        target = np.zeros((480, 640, 3), np.uint8)
        target[120:220, 120:240] = source[120:220, 120:240, :3]
        self.assertFalse(estimate(source, target)['accepted'])

    def test_rotation_not_fitted(self):
        source = fixture()
        transform = cv2.getRotationMatrix2D((320, 240), 12, 0.85)
        target = cv2.warpAffine(source, transform, (640, 480))
        self.assertFalse(estimate(source, target[:, :, :3])['accepted'])

    def test_contour_text_uniform_match(self):
        source = np.zeros((180, 600, 4), np.uint8)
        cv2.putText(source, 'NOVA SOUND', (50, 100), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (230,230,230,255), 2, cv2.LINE_AA)
        target = cv2.warpAffine(source[:,:,:3], np.array([[0.9,0,23],[0,0.9,10]],np.float64), (600,180))
        result = estimate_edges(source, target)
        self.assertTrue(result['accepted'], result)
        self.assertAlmostEqual(result['scale'], 0.9, delta=0.01)
        np.testing.assert_allclose(result['translation'], [23,10], atol=2)

    def test_contour_repeated_target_is_ambiguous(self):
        source = np.zeros((180, 600, 4), np.uint8)
        cv2.putText(source, 'ABC', (40,100), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (230,230,230,255),2,cv2.LINE_AA)
        target = source[:,:,:3].copy()
        cv2.putText(target, 'ABC', (340,100), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (230,230,230),2,cv2.LINE_AA)
        result = estimate_edges(source, target)
        self.assertFalse(result['accepted'], result)
        self.assertIn('competing',result['reason'])

    def test_contour_wrong_shape_rejected(self):
        source = np.zeros((180, 600, 4), np.uint8)
        cv2.putText(source, 'NOVA SOUND', (50,100), cv2.FONT_HERSHEY_SIMPLEX,1.4,(230,230,230,255),2,cv2.LINE_AA)
        target = np.zeros((180,600,3),np.uint8)
        cv2.putText(target, 'HELLO WORLD', (50,100), cv2.FONT_HERSHEY_SIMPLEX,1.4,(230,230,230),2,cv2.LINE_AA)
        self.assertFalse(estimate_edges(source,target)['accepted'])

    def test_auto_records_one_fallback_attempt(self):
        source = np.zeros((180, 600, 4), np.uint8)
        cv2.putText(source, 'NOVA SOUND', (50,100), cv2.FONT_HERSHEY_SIMPLEX,1.4,(230,230,230,255),2,cv2.LINE_AA)
        target = cv2.warpAffine(source[:,:,:3], np.array([[0.9,0,23],[0,0.9,10]],np.float64), (600,180))
        result = estimate_auto(source,target)
        self.assertTrue(result['accepted'],result)
        if result['method'] == 'edge':
            self.assertEqual([a['method'] for a in result['attempts']], ['sift','edge'])
            self.assertFalse(result['attempts'][0]['accepted'])

    def test_frozen_scope_disambiguates_only_outside_targets_preserving_coordinates_and_pixels(self):
        source=np.zeros((180,600,4),np.uint8)
        cv2.putText(source,'ABC',(40,100),cv2.FONT_HERSHEY_SIMPLEX,1.4,(230,230,230,255),2,cv2.LINE_AA)
        target=source[:,:,:3].copy()
        cv2.putText(target,'ABC',(340,100),cv2.FONT_HERSHEY_SIMPLEX,1.4,(230,230,230),2,cv2.LINE_AA)
        prior=source.copy();reference=target.copy()
        result=estimate_edges(source,target,[325,45,135,70])
        self.assertTrue(result['accepted'],result)
        np.testing.assert_allclose(result['translation'],[300,0],atol=2)
        self.assertEqual(result['referenceSize'],[600,180])
        self.assertEqual(result['measurementSearchBox'],[325,45,135,70])
        np.testing.assert_array_equal(source,prior);np.testing.assert_array_equal(target,reference)
        both=estimate_edges(source,target,[20,40,460,80])
        self.assertFalse(both['accepted'],both);self.assertIn('competing',both['reason'])

    def test_search_scope_cannot_clip_wrong_shape_or_legalize_invalid_box(self):
        source=np.zeros((180,600,4),np.uint8)
        cv2.putText(source,'NOVA SOUND',(50,100),cv2.FONT_HERSHEY_SIMPLEX,1.4,(230,230,230,255),2,cv2.LINE_AA)
        target=np.zeros((180,600,3),np.uint8)
        cv2.putText(target,'HELLO WORLD',(50,100),cv2.FONT_HERSHEY_SIMPLEX,1.4,(230,230,230),2,cv2.LINE_AA)
        self.assertFalse(estimate_edges(source,target,[20,30,540,90])['accepted'])
        self.assertFalse(estimate_edges(source,target,[50,70,20,20])['accepted'])
        for box in [[-1,0,10,10],[0,0,601,20],[0,0,10,0],[0,0,float('nan'),10]]:
            with self.assertRaises(ValueError):estimate_edges(source,target,box)


if __name__ == '__main__':
    unittest.main()
