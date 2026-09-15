# CTGPromptServerRequestError Types

`CTGPromptServerRequestError` uses the shared error code and result
types owned by
[CTGPromptServerError types](../CTGPromptServerError/types.md).

The inherited `code` field and request-specific `status` field are
assigned from constructor arguments. The inherited `label` getter is
derived from `code`. The response body produced by inherited
`toResponse()` is defined with [CTGPromptServer types](../CTGPromptServer/types.md)
as `CTGPromptErrorResponse` and contains only public `code` and
`message`.

`sendResponse(response)` is inherited from `CTGPromptServerError` and
uses `CTGPromptServerRequestError.status`.
