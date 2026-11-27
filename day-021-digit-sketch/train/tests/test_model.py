import numpy as np
import torch

from model import DigitCNN, count_params


def test_output_shape_is_ten_logits_per_image():
    model = DigitCNN()
    assert model(torch.zeros(5, 1, 28, 28)).shape == (5, 10)
    assert model(torch.zeros(1, 1, 28, 28)).shape == (1, 10)


def test_parameter_count_is_under_100k_and_matches_the_hand_count():
    n = count_params(DigitCNN())
    assert n < 100_000
    conv1, conv2 = 16 * 1 * 9 + 16, 32 * 16 * 9 + 32
    fc1, fc2 = 800 * 64 + 64, 64 * 10 + 10
    assert n == conv1 + conv2 + fc1 + fc2 == 56_714


def test_feature_map_shapes_follow_the_no_padding_arithmetic():
    a1, a2 = DigitCNN().feature_maps(torch.randn(2, 1, 28, 28))
    assert a1.shape == (2, 16, 26, 26)   # 28 - 3 + 1
    assert a2.shape == (2, 32, 11, 11)   # (26 / 2) - 3 + 1
    assert a1.min() >= 0 and a2.min() >= 0  # post-ReLU


def test_feature_maps_agree_with_the_forward_pass():
    torch.manual_seed(0)
    model, x = DigitCNN().eval(), torch.randn(3, 1, 28, 28)
    _, a2 = model.feature_maps(x)
    manual = model.fc2(torch.relu(model.fc1(model.pool(a2).flatten(1))))
    assert torch.allclose(manual, model(x), atol=1e-6)


def test_config_round_trips_to_an_identical_architecture():
    model = DigitCNN(c1=4, c2=6, hidden=10)
    clone = DigitCNN(**model.config())
    clone.load_state_dict(model.state_dict())
    x = torch.randn(2, 1, 28, 28)
    assert np.allclose(model(x).detach(), clone(x).detach())
