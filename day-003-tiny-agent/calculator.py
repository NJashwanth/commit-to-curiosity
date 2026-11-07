"""calculator tool: safe arithmetic by walking the ast, never eval."""
import ast
import operator

from errors import ToolError

MAX_EXPRESSION_LENGTH = 200
MAX_EXPONENT = 1000
MAX_INT_BITS = 4096

_BINARY = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}
_UNARY = {ast.UAdd: operator.pos, ast.USub: operator.neg}

SCHEMA = {
    "name": "calculator",
    "description": (
        "Evaluate an arithmetic expression exactly. Supports + - * / // % ** , parentheses and "
        "decimal numbers. Use it for any math instead of computing in your head. "
        "Example: '86.40 * 0.18'."
    ),
    "input_schema": {
        "type": "object",
        "properties": {"expression": {"type": "string", "description": "The arithmetic expression."}},
        "required": ["expression"],
    },
}


def _check_size(value):
    if isinstance(value, int) and value.bit_length() > MAX_INT_BITS:
        raise ToolError("Result is too large.")
    return value


def _eval(node):
    if isinstance(node, ast.Constant):
        # bool is a subclass of int, so True + 1 would otherwise sneak through.
        if isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
            return node.value
        raise ToolError("Only plain numbers are allowed.")
    if isinstance(node, ast.BinOp) and type(node.op) in _BINARY:
        left, right = _eval(node.left), _eval(node.right)
        if isinstance(node.op, ast.Pow) and abs(right) > MAX_EXPONENT:
            raise ToolError(f"Exponent is too large (limit {MAX_EXPONENT}).")
        try:
            return _check_size(_BINARY[type(node.op)](left, right))
        except ZeroDivisionError:
            raise ToolError("Division by zero.") from None
        except OverflowError:
            raise ToolError("Result is too large.") from None
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY:
        return _UNARY[type(node.op)](_eval(node.operand))
    # Names, calls, attribute access, subscripts, lambdas and everything else end up here.
    raise ToolError(f"Unsupported syntax: {type(node).__name__}. Only arithmetic is allowed.")


def calculate(expression):
    """Evaluate `expression` safely and return the result as a string."""
    if not isinstance(expression, str) or not expression.strip():
        raise ToolError("Provide a non-empty arithmetic expression.")
    if len(expression) > MAX_EXPRESSION_LENGTH:
        raise ToolError(f"Expression is too long (limit {MAX_EXPRESSION_LENGTH} characters).")
    try:
        tree = ast.parse(expression.strip(), mode="eval")
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        raise ToolError("Could not parse the expression.") from None
    try:
        result = _eval(tree.body)
    except RecursionError:
        raise ToolError("Expression is nested too deeply.") from None
    if isinstance(result, float):
        result = round(result, 10)
        if result.is_integer() and abs(result) < 1e15:
            result = int(result)
    return str(result)
