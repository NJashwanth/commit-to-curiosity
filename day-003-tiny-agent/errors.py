"""Error type shared by every tool."""


class ToolError(Exception):
    """A tool failed in a way worth explaining to the model.

    `retryable` marks transient failures (a network blip). The agent loop retries
    those, and gives up straight away on permanent ones like bad input.
    """

    def __init__(self, message, retryable=False):
        super().__init__(message)
        self.retryable = retryable
