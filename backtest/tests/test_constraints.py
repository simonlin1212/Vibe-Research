"""Joint constraints must hold in the returned frame, not just midway through it."""
import itertools

import numpy as np
import pandas as pd
import pytest

from backtest.constraints import MinWeight, apply_constraints_frame, load_constraints


@pytest.mark.parametrize("reverse", [False, True])
def test_group_and_name_caps_hold_together(reverse):
    specs = [
        {"type": "group_exposure", "groups": {"A": "tech", "B": "tech"}, "caps": {"tech": 0.2}},
        {"type": "max_weight", "cap": 0.4},
    ]
    if reverse:
        specs.reverse()
    frame = pd.DataFrame([[0.1, -0.1, 0.8, 0.0]], columns=list("ABCD"))
    out = apply_constraints_frame(frame, load_constraints({"constraints": specs}))
    assert out.iloc[0].abs().max() <= 0.4 + 1e-12
    assert out.loc[0, ["A", "B"]].abs().sum() <= 0.2 + 1e-12
    assert out.loc[0, "A"] > 0 and out.loc[0, "B"] < 0
    assert out.loc[0, "D"] == 0
    assert out.iloc[0].abs().sum() <= frame.iloc[0].abs().sum() + 1e-12
    pd.testing.assert_frame_equal(frame, pd.DataFrame([[0.1, -0.1, 0.8, 0.0]], columns=list("ABCD")))


@pytest.mark.parametrize("specs", list(itertools.permutations([
    {"type": "max_weight", "cap": 0.6},
    {"type": "min_weight", "floor": 0.1},
    {"type": "group_exposure", "groups": {"A": "tech", "B": "tech"}, "caps": {"tech": 0.5}},
])))
def test_feasible_floor_cap_group_combinations(specs):
    frame = pd.DataFrame([[0.05, 0.2, 0.75]], columns=list("ABC"))
    out = apply_constraints_frame(frame, load_constraints({"constraints": list(specs)})).iloc[0]
    assert out.min() >= 0.1 - 1e-12
    assert out.max() <= 0.6 + 1e-12
    assert out[["A", "B"]].sum() <= 0.5 + 1e-12


def test_incompatible_group_floor_fails_instead_of_claiming_success():
    frame = pd.DataFrame([[0.2, 0.2, 0.6]], columns=list("ABC"))
    constraints = load_constraints({"constraints": [
        {"type": "group_exposure", "groups": {"A": "tech", "B": "tech"}, "caps": {"tech": 0.2}},
        {"type": "min_weight", "floor": 0.15},
    ]})
    with pytest.raises(ValueError, match="constraint|floor"):
        apply_constraints_frame(frame, constraints)


def test_unfunded_floor_does_not_create_negative_or_below_floor_weights():
    with pytest.raises(ValueError, match="floor"):
        MinWeight(0.3).apply(np.array([0.01, 0.31]), ["A", "B"])


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), -float("inf")])
def test_nonfinite_input_is_not_silently_ignored(bad):
    with pytest.raises(ValueError, match="finite"):
        apply_constraints_frame(pd.DataFrame([[bad, 0.5]]), load_constraints({"constraints": [{"type": "max_weight", "cap": 0.4}]}))


def test_empty_constraints_are_identity_and_zero_rows_remain_zero():
    frame = pd.DataFrame([[0.0, 0.0]])
    assert apply_constraints_frame(frame, []) is frame
    pd.testing.assert_frame_equal(frame, apply_constraints_frame(frame, load_constraints({"constraints": [{"type": "min_weight", "floor": 0.1}]})))
