import pytest

from calculator import calculate
from errors import ToolError


@pytest.mark.parametrize(
    "expression, expected",
    [
        ("1 + 2", "3"),
        ("86.40 * 0.18", "15.552"),
        ("(2 + 3) * 4 - 1", "19"),
        ("2 ** 10", "1024"),
        ("7 // 2", "3"),
        ("7 % 4", "3"),
        ("10 / 4", "2.5"),
        ("-5 + +3", "-2"),
        ("0.1 + 0.2", "0.3"),
        ("6 / 3", "2"),
        ("  3 * 3  ", "9"),
    ],
)
def test_valid_math(expression, expected):
    assert calculate(expression) == expected


@pytest.mark.parametrize(
    "expression",
    [
        "__import__('os').system('echo hi')",
        "import os",
        "().__class__",
        "'abc'.upper()",
        "abs(-3)",
        "open('x')",
        "x + 1",
        "[1, 2][0]",
        "lambda: 1",
        "1 if True else 2",
        "'a' + 'b'",
        "True + 1",
        "None",
        "1 < 2",
        "3j",
    ],
)
def test_unsafe_or_unsupported_input_rejected(expression):
    with pytest.raises(ToolError):
        calculate(expression)


@pytest.mark.parametrize("expression", ["", "   ", "1 +", "2 $ 3", "1 + (2"])
def test_empty_or_malformed_rejected(expression):
    with pytest.raises(ToolError):
        calculate(expression)


def test_non_string_rejected():
    with pytest.raises(ToolError):
        calculate(42)


def test_division_by_zero_is_a_tool_error():
    with pytest.raises(ToolError, match="Division by zero"):
        calculate("1 / 0")
    with pytest.raises(ToolError, match="Division by zero"):
        calculate("1 % 0")


def test_huge_exponent_rejected():
    with pytest.raises(ToolError, match="Exponent"):
        calculate("9 ** 9 ** 9")


def test_huge_result_rejected():
    with pytest.raises(ToolError, match="too large"):
        calculate("((10 ** 1000) ** 1000) ** 2")
    with pytest.raises(ToolError, match="too large"):
        calculate("10.0 ** 999 * 10.0 ** 999")


def test_long_expression_rejected():
    with pytest.raises(ToolError, match="too long"):
        calculate("1+" * 150 + "1")


def test_deeply_nested_expression_rejected():
    with pytest.raises(ToolError):
        calculate("(" * 150 + "1" + ")" * 150)
