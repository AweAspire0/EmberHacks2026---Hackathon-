---
name: gemini-vision-compiler
description: The Gemini API call pattern used by Paper Machine. Read this before editing app.py.
---

# Gemini API pattern for Paper Machine

## Client

Use the `google-genai` SDK (not the older `google-generativeai` package).

```python
from google import genai
from google.genai import types

client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
```

## Model selection

Do **not** hardcode a model name inline. Model choice lives in exactly one place:
`MODEL_PREFERENCE` in `app.py`. If you change the model, change that list. Nowhere else.
`GEMINI_MODEL` in `.env` is an explicit override that always wins.

Two things make this less trivial than it looks, both hit for real on this key:

1. **Listing is not permission.** `gemini-2.5-flash` appears in `client.models.list()`
   but returns `404 ... no longer available to new users` when you actually call it.
2. **The newest model is newer than you think.** This key serves up to
   `gemini-3.8-flash`; a stale hardcoded guess silently costs you quality.

So `candidate_models()` intersects the preference list with the live listing (filtered to
models advertising `generateContent`), and `generate()` walks that list, treating a 404 /
NOT_FOUND as "try the next one" and caching the first model that actually works. Any other
exception propagates — we do not want a quota or auth error silently burning through six
models.

## Sending an image

Images go in as bytes, with the mime type, as the **first** part — the instruction
follows the image:

```python
response = client.models.generate_content(
    model=resolve_model(),
    contents=[
        types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg"),
        prompt,
    ],
    config=types.GenerateContentConfig(
        response_mime_type="application/json",
        temperature=0.1,
    ),
)
graph = json.loads(response.text)
```

## Structured output

We ask for JSON via `response_mime_type="application/json"` and describe the shape in
the prompt itself, rather than passing `response_schema`. This is deliberate: the schema
here is recursive-ish (edges reference node ids) and prompt-described schemas have proven
more portable across SDK versions under time pressure. Keep `extract_json()` as the
tolerant parser — models occasionally emit fences regardless of the mime type.

Use `temperature=0.1`. This is a perception task, not a creative one.

## Never trust the output structurally

Gemini reads handwriting well but will occasionally reference a node id in an edge that
it did not emit in `nodes`. `normalize()` in `app.py` is the contract boundary:

- slugify and de-duplicate every node id
- map whatever the model called a node onto our cleaned ids (by id *and* by label)
- drop edges pointing at shapes that were not detected, and say so in `warnings`
- guarantee exactly one `start` node

The frontend executes the graph directly, so anything `normalize()` lets through must be
runnable. Add validation there, not in JavaScript.

## Warnings are a feature

`warnings` is surfaced in the UI on purpose. It is how the interface admits what it could
not read, instead of silently guessing. Keep prompting the model to populate it.
